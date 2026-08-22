#!/usr/bin/env node
/*
 * Al Ayn — Sadaqa Box Tracker
 * Zero-dependency Node.js server (built-in http + node:sqlite).
 * Run with:  node server.js
 */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const Anthropic = require('@anthropic-ai/sdk');

const PORT = process.env.PORT || 3040;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const PUBLIC_DIR = path.join(__dirname, 'public');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new DatabaseSync(path.join(DATA_DIR, 'sadaqa.db'));
db.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS donors (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    first_name TEXT NOT NULL,
    last_name TEXT NOT NULL,
    phone TEXT NOT NULL,
    notes TEXT DEFAULT '',
    created_at TEXT DEFAULT (date('now'))
  );
  CREATE TABLE IF NOT EXISTS assignments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    donor_id INTEGER NOT NULL REFERENCES donors(id),
    box_number TEXT NOT NULL,
    lock_number TEXT NOT NULL,
    date_given TEXT NOT NULL,
    due_date TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'out',        -- out | exchanged | returned
    date_closed TEXT,
    amount_collected REAL,
    notes TEXT DEFAULT '',
    last_reminded_at TEXT,
    created_at TEXT DEFAULT (date('now'))
  );
  CREATE TABLE IF NOT EXISTS locations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    address TEXT DEFAULT '',
    hours TEXT DEFAULT '',
    active INTEGER DEFAULT 1
  );
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT
  );
`);

// Migration: email column on donors (added after first release)
const donorColumns = db.prepare("SELECT name FROM pragma_table_info('donors')").all().map((c) => c.name);
if (!donorColumns.includes('email')) {
  db.exec("ALTER TABLE donors ADD COLUMN email TEXT DEFAULT ''");
}

const DEFAULT_SETTINGS = {
  cycle_days: '90',
  due_soon_days: '14',
  anthropic_api_key: '',
  message_template:
    'Assalamu Alaikum {name} 🤲\n\n' +
    'This is a friendly reminder from the Al Ayn team. Your Sadaqa box (Box #{box_number}) is due for exchange on {due_date}.\n\n' +
    'You can exchange it with a team member, or drop it off at any of these locations:\n{locations}\n\n' +
    'JazakAllah Khair for your continued support of the orphans. May Allah reward you.',
};
const getSettingStmt = db.prepare('SELECT value FROM settings WHERE key = ?');
const setSettingStmt = db.prepare(
  'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
);
for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) {
  if (!getSettingStmt.get(k)) setSettingStmt.run(k, v);
}

// ---------- auth ----------
function getSetting(k) {
  return getSettingStmt.get(k)?.value;
}
if (!getSetting('session_secret')) {
  setSettingStmt.run('session_secret', crypto.randomBytes(32).toString('hex'));
}
const SESSION_SECRET = getSetting('session_secret');
const SESSION_DAYS = 90;

function hashPassword(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  return `${salt}:${crypto.scryptSync(pw, salt, 64).toString('hex')}`;
}

function verifyPassword(pw, stored) {
  const [salt, hash] = String(stored).split(':');
  if (!salt || !hash) return false;
  return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), crypto.scryptSync(pw, salt, 64));
}

function signSession(exp) {
  return crypto.createHmac('sha256', SESSION_SECRET).update(String(exp)).digest('hex');
}

function makeSessionCookie(req) {
  const exp = Date.now() + SESSION_DAYS * 86400000;
  const secure = req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
  return `sadaqa_session=${exp}.${signSession(exp)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_DAYS * 86400}${secure}`;
}

function isAuthed(req) {
  const m = /(?:^|;\s*)sadaqa_session=([^;]+)/.exec(req.headers.cookie || '');
  if (!m) return false;
  const [expStr, sig] = m[1].split('.');
  const exp = Number(expStr);
  if (!exp || exp < Date.now() || !sig) return false;
  const expected = signSession(exp);
  return sig.length === expected.length && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
}

const loginAttempts = new Map();
function tooManyAttempts(ip) {
  const now = Date.now();
  const recent = (loginAttempts.get(ip) || []).filter((t) => now - t < 15 * 60000);
  loginAttempts.set(ip, recent);
  return recent.length >= 20;
}

// Requests allowed without a login session
const PUBLIC_PATHS = new Set([
  '/login.html', '/style.css', '/logo.svg', '/logo.png',
  '/api/login', '/api/setup', '/api/auth-status',
]);

// ---------- helpers ----------
const ASSIGNMENT_SELECT = `
  SELECT a.*, d.first_name, d.last_name, d.phone
  FROM assignments a JOIN donors d ON d.id = a.donor_id
`;

function today() {
  return new Date().toISOString().slice(0, 10);
}

function json(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(data);
}

function badRequest(res, message) {
  json(res, 400, { error: message });
}

function readBody(req, limit = 1e6) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > limit) reject(new Error('Body too large'));
    });
    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch {
        reject(new Error('Invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

function requireFields(res, body, fields) {
  for (const f of fields) {
    if (body[f] === undefined || body[f] === null || String(body[f]).trim() === '') {
      badRequest(res, `Missing required field: ${f.replace(/_/g, ' ')}`);
      return false;
    }
  }
  return true;
}

function findOrCreateDonor(body) {
  if (body.donor_id) return Number(body.donor_id);
  const first = String(body.first_name).trim();
  const last = String(body.last_name || '').trim();
  const phone = String(body.phone).trim();
  const email = String(body.email || '').trim();
  const existing = db
    .prepare("SELECT id FROM donors WHERE replace(replace(phone,' ',''),'-','') = replace(replace(?,' ',''),'-','')")
    .get(phone);
  if (existing) {
    db.prepare("UPDATE donors SET first_name = ?, last_name = ?, email = CASE WHEN ? = '' THEN email ELSE ? END WHERE id = ?")
      .run(first, last, email, email, existing.id);
    return existing.id;
  }
  const r = db.prepare('INSERT INTO donors (first_name, last_name, phone, email) VALUES (?, ?, ?, ?)').run(first, last, phone, email);
  return Number(r.lastInsertRowid);
}

// ---------- routes ----------
const routes = [];
function route(method, pattern, handler) {
  routes.push({ method, pattern: new RegExp(`^${pattern}$`), handler });
}

route('GET', '/api/auth-status', (req, res) => {
  json(res, 200, { setup_required: !getSetting('password_hash'), authenticated: isAuthed(req) });
});

route('POST', '/api/setup', async (req, res) => {
  if (getSetting('password_hash')) return badRequest(res, 'A team password is already set.');
  const body = await readBody(req);
  const pw = String(body.password || '');
  if (pw.length < 8) return badRequest(res, 'The password must be at least 8 characters.');
  setSettingStmt.run('password_hash', hashPassword(pw));
  res.writeHead(200, { 'Content-Type': 'application/json', 'Set-Cookie': makeSessionCookie(req) });
  res.end('{"ok":true}');
});

route('POST', '/api/login', async (req, res) => {
  const ip = req.socket.remoteAddress || '';
  if (tooManyAttempts(ip)) return badRequest(res, 'Too many attempts — wait 15 minutes and try again.');
  const body = await readBody(req);
  const stored = getSetting('password_hash');
  if (!stored) return badRequest(res, 'No team password has been set up yet.');
  if (!verifyPassword(String(body.password || ''), stored)) {
    loginAttempts.get(ip).push(Date.now());
    return json(res, 401, { error: 'Wrong password.' });
  }
  res.writeHead(200, { 'Content-Type': 'application/json', 'Set-Cookie': makeSessionCookie(req) });
  res.end('{"ok":true}');
});

route('POST', '/api/logout', (req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/json', 'Set-Cookie': 'sadaqa_session=; HttpOnly; Path=/; Max-Age=0' });
  res.end('{"ok":true}');
});

route('GET', '/api/backup', (req, res) => {
  const tmp = path.join(DATA_DIR, `backup-tmp-${Date.now()}.db`);
  db.exec(`VACUUM INTO '${tmp.replace(/'/g, "''")}'`);
  res.writeHead(200, {
    'Content-Type': 'application/octet-stream',
    'Content-Disposition': `attachment; filename="sadaqa-backup-${today()}.db"`,
  });
  const stream = fs.createReadStream(tmp);
  stream.pipe(res);
  stream.on('close', () => fs.unlink(tmp, () => {}));
});

route('GET', '/api/dashboard', (req, res) => {
  const dueSoonDays = Number(getSettingStmt.get('due_soon_days')?.value || 14);
  const t = today();
  const out = db.prepare(`${ASSIGNMENT_SELECT} WHERE a.status = 'out' ORDER BY a.due_date`).all();
  const overdue = out.filter((a) => a.due_date < t);
  const horizon = new Date(Date.now() + dueSoonDays * 86400000).toISOString().slice(0, 10);
  const dueSoon = out.filter((a) => a.due_date >= t && a.due_date <= horizon);
  const monthStart = t.slice(0, 8) + '01';
  const yearStart = t.slice(0, 5) + '01-01';
  const exchangedThisMonth = db
    .prepare("SELECT COUNT(*) n FROM assignments WHERE status != 'out' AND date_closed >= ?")
    .get(monthStart).n;
  const collectedThisYear = db
    .prepare("SELECT COALESCE(SUM(amount_collected),0) s FROM assignments WHERE date_closed >= ?")
    .get(yearStart).s;
  json(res, 200, {
    stats: {
      boxes_out: out.length,
      overdue: overdue.length,
      due_soon: dueSoon.length,
      exchanged_this_month: exchangedThisMonth,
      collected_this_year: collectedThisYear,
      due_soon_days: dueSoonDays,
    },
    overdue,
    due_soon: dueSoon,
  });
});

route('GET', '/api/assignments', (req, res, m, query) => {
  const status = query.get('status');
  const q = (query.get('q') || '').trim().toLowerCase();
  let rows;
  if (status === 'closed') {
    rows = db.prepare(`${ASSIGNMENT_SELECT} WHERE a.status != 'out' ORDER BY a.date_closed DESC`).all();
  } else if (status === 'out') {
    rows = db.prepare(`${ASSIGNMENT_SELECT} WHERE a.status = 'out' ORDER BY a.due_date`).all();
  } else {
    rows = db.prepare(`${ASSIGNMENT_SELECT} ORDER BY a.status = 'out' DESC, a.due_date`).all();
  }
  if (q) {
    rows = rows.filter((r) =>
      [r.first_name, r.last_name, `${r.first_name} ${r.last_name}`, r.phone, r.box_number, r.lock_number]
        .some((v) => String(v || '').toLowerCase().includes(q))
    );
  }
  json(res, 200, rows);
});

route('POST', '/api/assignments', async (req, res) => {
  const body = await readBody(req);
  const donorFields = body.donor_id ? [] : ['first_name', 'phone'];
  if (!requireFields(res, body, [...donorFields, 'box_number', 'lock_number', 'date_given', 'due_date'])) return;
  const boxNumber = String(body.box_number).trim();
  const clash = db
    .prepare("SELECT a.id, d.first_name, d.last_name FROM assignments a JOIN donors d ON d.id=a.donor_id WHERE a.status='out' AND a.box_number = ?")
    .get(boxNumber);
  if (clash) {
    return badRequest(res, `Box #${boxNumber} is already out with ${clash.first_name} ${clash.last_name}. Exchange or return it first.`);
  }
  const donorId = findOrCreateDonor(body);
  const r = db
    .prepare('INSERT INTO assignments (donor_id, box_number, lock_number, date_given, due_date, notes) VALUES (?, ?, ?, ?, ?, ?)')
    .run(donorId, boxNumber, String(body.lock_number).trim(), body.date_given, body.due_date, body.notes || '');
  json(res, 201, db.prepare(`${ASSIGNMENT_SELECT} WHERE a.id = ?`).get(Number(r.lastInsertRowid)));
});

route('PUT', '/api/assignments/(\\d+)', async (req, res, m) => {
  const id = Number(m[1]);
  const body = await readBody(req);
  const existing = db.prepare('SELECT * FROM assignments WHERE id = ?').get(id);
  if (!existing) return json(res, 404, { error: 'Not found' });
  db.prepare('UPDATE assignments SET box_number=?, lock_number=?, date_given=?, due_date=?, notes=? WHERE id=?').run(
    String(body.box_number ?? existing.box_number).trim(),
    String(body.lock_number ?? existing.lock_number).trim(),
    body.date_given ?? existing.date_given,
    body.due_date ?? existing.due_date,
    body.notes ?? existing.notes,
    id
  );
  json(res, 200, db.prepare(`${ASSIGNMENT_SELECT} WHERE a.id = ?`).get(id));
});

route('POST', '/api/assignments/(\\d+)/close', async (req, res, m) => {
  const id = Number(m[1]);
  const body = await readBody(req);
  const existing = db.prepare('SELECT * FROM assignments WHERE id = ?').get(id);
  if (!existing) return json(res, 404, { error: 'Not found' });
  if (existing.status !== 'out') return badRequest(res, 'This box has already been closed.');
  const outcome = body.outcome === 'returned' ? 'returned' : 'exchanged';
  const dateClosed = body.date_closed || today();
  const amount = body.amount_collected === '' || body.amount_collected == null ? null : Number(body.amount_collected);
  db.prepare('UPDATE assignments SET status=?, date_closed=?, amount_collected=?, notes=? WHERE id=?').run(
    outcome, dateClosed, amount, body.notes ?? existing.notes, id
  );
  let newAssignment = null;
  if (body.new_box && body.new_box.box_number && body.new_box.lock_number) {
    const nb = body.new_box;
    const clash = db
      .prepare("SELECT id FROM assignments WHERE status='out' AND box_number = ?")
      .get(String(nb.box_number).trim());
    if (clash) return badRequest(res, `New box #${nb.box_number} is already out with another donor. The old box was NOT closed — please retry with a different box number.`);
    const cycleDays = Number(getSettingStmt.get('cycle_days')?.value || 90);
    const due = nb.due_date || new Date(new Date(dateClosed).getTime() + cycleDays * 86400000).toISOString().slice(0, 10);
    const r = db
      .prepare('INSERT INTO assignments (donor_id, box_number, lock_number, date_given, due_date) VALUES (?, ?, ?, ?, ?)')
      .run(existing.donor_id, String(nb.box_number).trim(), String(nb.lock_number).trim(), dateClosed, due);
    newAssignment = db.prepare(`${ASSIGNMENT_SELECT} WHERE a.id = ?`).get(Number(r.lastInsertRowid));
  }
  json(res, 200, { closed: db.prepare(`${ASSIGNMENT_SELECT} WHERE a.id = ?`).get(id), new_assignment: newAssignment });
});

route('POST', '/api/assignments/(\\d+)/reminded', (req, res, m) => {
  const id = Number(m[1]);
  db.prepare('UPDATE assignments SET last_reminded_at = ? WHERE id = ?').run(new Date().toISOString(), id);
  json(res, 200, { ok: true });
});

route('DELETE', '/api/assignments/(\\d+)', (req, res, m) => {
  db.prepare('DELETE FROM assignments WHERE id = ?').run(Number(m[1]));
  json(res, 200, { ok: true });
});

route('GET', '/api/donors', (req, res, m, query) => {
  const q = (query.get('q') || '').trim().toLowerCase();
  let rows = db
    .prepare(`
      SELECT d.*,
        (SELECT COUNT(*) FROM assignments a WHERE a.donor_id = d.id AND a.status = 'out') AS boxes_out,
        (SELECT COUNT(*) FROM assignments a WHERE a.donor_id = d.id) AS total_boxes
      FROM donors d ORDER BY d.first_name, d.last_name
    `)
    .all();
  if (q) {
    rows = rows.filter((r) =>
      [`${r.first_name} ${r.last_name}`, r.phone, r.email].some((v) => String(v || '').toLowerCase().includes(q))
    );
  }
  json(res, 200, rows);
});

route('GET', '/api/donors/(\\d+)', (req, res, m) => {
  const donor = db.prepare('SELECT * FROM donors WHERE id = ?').get(Number(m[1]));
  if (!donor) return json(res, 404, { error: 'Not found' });
  const history = db.prepare(`${ASSIGNMENT_SELECT} WHERE a.donor_id = ? ORDER BY a.date_given DESC`).all(donor.id);
  json(res, 200, { donor, history });
});

route('PUT', '/api/donors/(\\d+)', async (req, res, m) => {
  const id = Number(m[1]);
  const body = await readBody(req);
  if (!requireFields(res, body, ['first_name', 'phone'])) return;
  db.prepare('UPDATE donors SET first_name=?, last_name=?, phone=?, email=?, notes=? WHERE id=?').run(
    String(body.first_name).trim(), String(body.last_name || '').trim(), String(body.phone).trim(),
    String(body.email || '').trim(), body.notes || '', id
  );
  json(res, 200, db.prepare('SELECT * FROM donors WHERE id = ?').get(id));
});

route('GET', '/api/locations', (req, res) => {
  json(res, 200, db.prepare('SELECT * FROM locations ORDER BY active DESC, name').all());
});

route('POST', '/api/locations', async (req, res) => {
  const body = await readBody(req);
  if (!requireFields(res, body, ['name'])) return;
  const r = db.prepare('INSERT INTO locations (name, address, hours) VALUES (?, ?, ?)').run(
    String(body.name).trim(), body.address || '', body.hours || ''
  );
  json(res, 201, db.prepare('SELECT * FROM locations WHERE id = ?').get(Number(r.lastInsertRowid)));
});

route('PUT', '/api/locations/(\\d+)', async (req, res, m) => {
  const id = Number(m[1]);
  const body = await readBody(req);
  const existing = db.prepare('SELECT * FROM locations WHERE id = ?').get(id);
  if (!existing) return json(res, 404, { error: 'Not found' });
  db.prepare('UPDATE locations SET name=?, address=?, hours=?, active=? WHERE id=?').run(
    body.name ?? existing.name,
    body.address ?? existing.address,
    body.hours ?? existing.hours,
    body.active === undefined ? existing.active : (body.active ? 1 : 0),
    id
  );
  json(res, 200, db.prepare('SELECT * FROM locations WHERE id = ?').get(id));
});

route('DELETE', '/api/locations/(\\d+)', (req, res, m) => {
  db.prepare('DELETE FROM locations WHERE id = ?').run(Number(m[1]));
  json(res, 200, { ok: true });
});

const PRIVATE_SETTINGS = new Set(['password_hash', 'session_secret']);

route('GET', '/api/settings', (req, res) => {
  const all = {};
  for (const row of db.prepare('SELECT key, value FROM settings').all()) {
    if (!PRIVATE_SETTINGS.has(row.key)) all[row.key] = row.value;
  }
  json(res, 200, all);
});

route('PUT', '/api/settings', async (req, res) => {
  const body = await readBody(req);
  for (const [k, v] of Object.entries(body)) {
    if (!PRIVATE_SETTINGS.has(k)) setSettingStmt.run(k, String(v));
  }
  json(res, 200, { ok: true });
});

// ---------- scan a paper sign-up sheet ----------
const SCAN_SCHEMA = {
  type: 'object',
  properties: {
    rows: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          first_name: { type: 'string' },
          last_name: { type: 'string' },
          phone: { type: 'string' },
          email: { type: 'string' },
          box_number: { type: 'string' },
          lock_number: { type: 'string' },
        },
        required: ['first_name', 'last_name', 'phone', 'email', 'box_number', 'lock_number'],
        additionalProperties: false,
      },
    },
  },
  required: ['rows'],
  additionalProperties: false,
};

const SCAN_PROMPT = `This is a photo of a handwritten sign-up sheet used by the Al Ayn Foundation to hand out Sadaqa (charity) boxes to donors. The table columns are: first name, last name (optional), phone number, email (optional), box number, lock number.

Extract every row that has any handwriting in it. Rules:
- Names may be written in Arabic or English. Transcribe them exactly as written, in the same script — do not translate or transliterate.
- The last name may be empty; that is normal. Use "" for any empty or unreadable cell.
- Phone numbers: transcribe all digits. Convert Arabic-Indic numerals (٠١٢٣٤٥٦٧٨٩) to Western digits (0123456789). Keep a leading + if written.
- Box number and lock number are usually short codes or numbers; convert Arabic-Indic numerals to Western digits there too.
- Skip completely empty rows. Do not invent data.`;

route('POST', '/api/scan', async (req, res) => {
  const body = await readBody(req, 20e6);
  if (!body.image_base64) return badRequest(res, 'No image received.');
  const apiKey = (getSettingStmt.get('anthropic_api_key')?.value || process.env.ANTHROPIC_API_KEY || '').trim();
  if (!apiKey) {
    return badRequest(res, 'No Claude API key set. Add one in Settings (get a key at console.anthropic.com).');
  }
  const client = new Anthropic({ apiKey });
  try {
    const response = await client.messages.create({
      model: 'claude-opus-4-8',
      max_tokens: 8000,
      thinking: { type: 'adaptive' },
      messages: [{
        role: 'user',
        content: [
          {
            type: 'image',
            source: {
              type: 'base64',
              media_type: body.media_type || 'image/jpeg',
              data: body.image_base64,
            },
          },
          { type: 'text', text: SCAN_PROMPT },
        ],
      }],
      output_config: { format: { type: 'json_schema', schema: SCAN_SCHEMA } },
    });
    if (response.stop_reason === 'refusal') {
      return badRequest(res, 'The image could not be processed. Please try a clearer photo.');
    }
    const text = response.content.find((b) => b.type === 'text')?.text || '{"rows":[]}';
    json(res, 200, JSON.parse(text));
  } catch (err) {
    if (err instanceof Anthropic.AuthenticationError) {
      return badRequest(res, 'The Claude API key is invalid. Check it in Settings.');
    }
    if (err instanceof Anthropic.RateLimitError) {
      return badRequest(res, 'Too many scans in a short time — wait a minute and try again.');
    }
    json(res, 500, { error: `Scan failed: ${err.message}` });
  }
});

// ---------- static files ----------
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png' };
function serveStatic(req, res, pathname) {
  const rel = pathname === '/' ? 'index.html' : pathname.slice(1);
  const file = path.join(PUBLIC_DIR, path.normalize(rel));
  if (!file.startsWith(PUBLIC_DIR) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    return res.end('Not found');
  }
  res.writeHead(200, { 'Content-Type': (MIME[path.extname(file)] || 'application/octet-stream') + '; charset=utf-8' });
  fs.createReadStream(file).pipe(res);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  try {
    if (!PUBLIC_PATHS.has(url.pathname) && !isAuthed(req)) {
      if (url.pathname.startsWith('/api/')) return json(res, 401, { error: 'Not logged in.' });
      res.writeHead(302, { Location: '/login.html' });
      return res.end();
    }
    for (const r of routes) {
      if (r.method !== req.method) continue;
      const m = url.pathname.match(r.pattern);
      if (m) return await r.handler(req, res, m, url.searchParams);
    }
    if (req.method === 'GET') return serveStatic(req, res, url.pathname);
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
  } catch (err) {
    json(res, 500, { error: err.message });
  }
});

server.listen(PORT, '0.0.0.0', () => {
  const nets = os.networkInterfaces();
  const lan = Object.values(nets).flat().find((n) => n && n.family === 'IPv4' && !n.internal);
  console.log('');
  console.log('  Al Ayn — Sadaqa Box Tracker is running');
  console.log(`  On this computer:  http://localhost:${PORT}`);
  if (lan) console.log(`  For the team (same WiFi):  http://${lan.address}:${PORT}`);
  console.log('');
});
