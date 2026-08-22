/* Al Ayn — Sadaqa Box Tracker (frontend) */

let settings = {};
let locations = [];

// ---------- helpers ----------
async function api(path, opts = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  if (res.status === 401) {
    location.href = '/login.html';
    throw new Error('Not logged in.');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

function fullName(a) {
  return `${a.first_name || ''} ${a.last_name || ''}`.trim();
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function todayISO() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function addDaysISO(iso, days) {
  const d = new Date(iso + 'T12:00:00');
  d.setDate(d.getDate() + days);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function fmtDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso + 'T12:00:00');
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}

function dueBadge(iso) {
  const t = todayISO();
  const days = Math.round((new Date(iso + 'T12:00:00') - new Date(t + 'T12:00:00')) / 86400000);
  if (days < 0) return `<span class="badge overdue">${-days} day${days === -1 ? '' : 's'} overdue</span>`;
  if (days === 0) return `<span class="badge due-soon">Due today</span>`;
  if (days <= Number(settings.due_soon_days || 14)) return `<span class="badge due-soon">Due in ${days} day${days === 1 ? '' : 's'}</span>`;
  return `<span class="badge ok">Due in ${days} days</span>`;
}

let toastTimer;
function toast(msg, isError = false) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.className = 'toast' + (isError ? ' error' : '');
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), 3500);
}

// ---------- modal ----------
const backdrop = document.getElementById('modal-backdrop');
function openModal(title, bodyHTML) {
  document.getElementById('modal-title').textContent = title;
  document.getElementById('modal-body').innerHTML = bodyHTML;
  backdrop.hidden = false;
}
function closeModal() { backdrop.hidden = true; }
document.getElementById('modal-close').onclick = closeModal;
backdrop.addEventListener('click', (e) => { if (e.target === backdrop) closeModal(); });

// ---------- WhatsApp ----------
function locationsText() {
  const active = locations.filter((l) => l.active);
  if (!active.length) return 'Please contact the team to arrange the exchange.';
  return active
    .map((l) => `• ${l.name}${l.address ? ' — ' + l.address : ''}${l.hours ? ' (' + l.hours + ')' : ''}`)
    .join('\n');
}

function buildMessage(a) {
  return (settings.message_template || '')
    .replaceAll('{name}', fullName(a))
    .replaceAll('{first_name}', a.first_name)
    .replaceAll('{box_number}', a.box_number)
    .replaceAll('{lock_number}', a.lock_number)
    .replaceAll('{due_date}', fmtDate(a.due_date))
    .replaceAll('{locations}', locationsText());
}

function waLink(phone, message) {
  let digits = String(phone).replace(/\D/g, '');
  if (digits.startsWith('00')) digits = digits.slice(2);
  return `https://wa.me/${digits}?text=${encodeURIComponent(message)}`;
}

async function sendReminder(a) {
  window.open(waLink(a.phone, buildMessage(a)), '_blank');
  try {
    await api(`/api/assignments/${a.id}/reminded`, { method: 'POST' });
  } catch {}
  refreshCurrentTab();
}

// ---------- tabs ----------
const tabButtons = document.querySelectorAll('#tabs button');
let currentTab = 'dashboard';
tabButtons.forEach((b) =>
  b.addEventListener('click', () => {
    tabButtons.forEach((x) => x.classList.remove('active'));
    b.classList.add('active');
    document.querySelectorAll('.tab-page').forEach((p) => (p.hidden = true));
    currentTab = b.dataset.tab;
    document.getElementById('tab-' + currentTab).hidden = false;
    refreshCurrentTab();
  })
);

function refreshCurrentTab() {
  ({ dashboard: loadDashboard, boxes: loadBoxes, donors: loadDonors, locations: loadLocations, settings: loadSettingsTab }[currentTab])();
}

// ---------- dashboard ----------
async function loadDashboard() {
  const d = await api('/api/dashboard');
  const s = d.stats;
  document.getElementById('stat-row').innerHTML = `
    <div class="stat-card"><div class="num">${s.boxes_out}</div><div class="label">Boxes out with donors</div></div>
    <div class="stat-card ${s.overdue ? 'alert' : ''}"><div class="num">${s.overdue}</div><div class="label">Overdue</div></div>
    <div class="stat-card ${s.due_soon ? 'warn' : ''}"><div class="num">${s.due_soon}</div><div class="label">Due in next ${s.due_soon_days} days</div></div>
    <div class="stat-card"><div class="num">${s.exchanged_this_month}</div><div class="label">Exchanged this month</div></div>
    <div class="stat-card"><div class="num">${s.collected_this_year ? '$' + Number(s.collected_this_year).toLocaleString() : '—'}</div><div class="label">Recorded collected this year</div></div>`;
  document.getElementById('due-soon-hint').textContent = `Boxes due within ${s.due_soon_days} days`;
  document.getElementById('overdue-table').innerHTML = assignmentTable(d.overdue, 'No overdue boxes. 🎉');
  document.getElementById('due-soon-table').innerHTML = assignmentTable(d.due_soon, 'Nothing due soon.');
}

function remindedNote(a) {
  if (!a.last_reminded_at) return '';
  return `<div class="reminded-note">Reminded ${fmtDate(a.last_reminded_at.slice(0, 10))}</div>`;
}

function assignmentTable(rows, emptyMsg) {
  if (!rows.length) return `<div class="empty">${emptyMsg}</div>`;
  return `<table><thead><tr>
      <th>Donor</th><th>Phone</th><th>Box #</th><th>Lock #</th><th>Given</th><th>Due</th><th></th>
    </tr></thead><tbody>` +
    rows.map((a) => `<tr>
      <td dir="auto"><strong>${esc(fullName(a))}</strong>${remindedNote(a)}</td>
      <td>${esc(a.phone)}</td>
      <td>${esc(a.box_number)}</td>
      <td>${esc(a.lock_number)}</td>
      <td>${fmtDate(a.date_given)}</td>
      <td>${dueBadge(a.due_date)}<div class="sub">${fmtDate(a.due_date)}</div></td>
      <td><div class="row-actions">
        <button class="btn small whatsapp" onclick='sendReminder(${JSON.stringify(a)})'>WhatsApp</button>
        <button class="btn small" onclick="openCloseModal(${a.id})">Exchange</button>
      </div></td>
    </tr>`).join('') + '</tbody></table>';
}

// ---------- boxes ----------
async function loadBoxes() {
  const q = document.getElementById('box-search').value;
  const status = document.getElementById('box-filter').value;
  const rows = await api(`/api/assignments?status=${status === 'all' ? '' : status}&q=${encodeURIComponent(q)}`);
  const el = document.getElementById('boxes-table');
  if (!rows.length) { el.innerHTML = '<div class="empty">No boxes found. Use “+ Give out a box” to register one.</div>'; return; }
  el.innerHTML = `<table><thead><tr>
      <th>Donor</th><th>Phone</th><th>Box #</th><th>Lock #</th><th>Given</th><th>Status</th><th></th>
    </tr></thead><tbody>` +
    rows.map((a) => {
      const status = a.status === 'out'
        ? `${dueBadge(a.due_date)}<div class="sub">Due ${fmtDate(a.due_date)}</div>`
        : `<span class="badge closed">${a.status === 'exchanged' ? 'Exchanged' : 'Returned'} ${fmtDate(a.date_closed)}</span>` +
          (a.amount_collected != null ? `<div class="sub">$${Number(a.amount_collected).toLocaleString()} collected</div>` : '');
      const actions = a.status === 'out'
        ? `<button class="btn small whatsapp" onclick='sendReminder(${JSON.stringify(a)})'>WhatsApp</button>
           <button class="btn small" onclick="openCloseModal(${a.id})">Exchange</button>
           <button class="btn small" onclick="openEditAssignment(${a.id})">Edit</button>`
        : '';
      return `<tr>
        <td dir="auto"><strong>${esc(fullName(a))}</strong>${a.status === 'out' ? remindedNote(a) : ''}</td>
        <td>${esc(a.phone)}</td>
        <td>${esc(a.box_number)}</td>
        <td>${esc(a.lock_number)}</td>
        <td>${fmtDate(a.date_given)}</td>
        <td>${status}</td>
        <td><div class="row-actions">${actions}</div></td>
      </tr>`;
    }).join('') + '</tbody></table>';
}
document.getElementById('box-search').addEventListener('input', () => loadBoxes());
document.getElementById('box-filter').addEventListener('change', () => loadBoxes());

// ---------- new / edit assignment ----------
document.getElementById('btn-new-box').onclick = () => openNewAssignment();

function openNewAssignment(prefillDonor) {
  const given = todayISO();
  const due = addDaysISO(given, Number(settings.cycle_days || 90));
  openModal('Give out a Sadaqa box', `
    <div class="form-grid">
      <label>Name (any language)<input id="f-first" dir="auto" value="${esc(prefillDonor?.first_name || '')}" /></label>
      <label>Last name (optional)<input id="f-last" dir="auto" value="${esc(prefillDonor?.last_name || '')}" /></label>
      <label class="full">Phone (with country code, e.g. +964…)<input id="f-phone" value="${esc(prefillDonor?.phone || '')}" placeholder="+964 770 000 0000" />
        <div id="donor-match"></div></label>
      <label class="full">Email (optional)<input id="f-email" type="email" value="${esc(prefillDonor?.email || '')}" /></label>
      <label>Box number<input id="f-box" /></label>
      <label>Lock number<input id="f-lock" /></label>
      <label>Date given<input type="date" id="f-given" value="${given}" /></label>
      <label>Due for exchange<input type="date" id="f-due" value="${due}" /></label>
      <label class="full">Notes (optional)<input id="f-notes" /></label>
    </div>
    <div class="form-actions"><button class="btn primary" id="f-save">Save box</button></div>
  `);
  document.getElementById('f-given').addEventListener('change', (e) => {
    if (e.target.value) document.getElementById('f-due').value = addDaysISO(e.target.value, Number(settings.cycle_days || 90));
  });
  document.getElementById('f-phone').addEventListener('blur', async (e) => {
    const q = e.target.value.trim();
    const matchEl = document.getElementById('donor-match');
    matchEl.innerHTML = '';
    if (q.length < 5) return;
    const donors = await api(`/api/donors?q=${encodeURIComponent(q)}`);
    if (donors.length) {
      const d = donors[0];
      matchEl.innerHTML = `<div class="donor-match">Existing donor found: <strong dir="auto">${esc(fullName(d))}</strong> (${d.total_boxes} previous box${d.total_boxes === 1 ? '' : 'es'}). This box will be added to their record.</div>`;
      document.getElementById('f-first').value = d.first_name;
      document.getElementById('f-last').value = d.last_name;
      if (d.email) document.getElementById('f-email').value = d.email;
    }
  });
  document.getElementById('f-save').onclick = async () => {
    try {
      await api('/api/assignments', { method: 'POST', body: {
        first_name: val('f-first'), last_name: val('f-last'), phone: val('f-phone'),
        email: val('f-email'),
        box_number: val('f-box'), lock_number: val('f-lock'),
        date_given: val('f-given'), due_date: val('f-due'), notes: val('f-notes'),
      }});
      closeModal();
      toast('Box registered ✓');
      refreshCurrentTab();
    } catch (err) { toast(err.message, true); }
  };
}

function val(id) { return document.getElementById(id).value.trim(); }

async function openEditAssignment(id) {
  const rows = await api('/api/assignments');
  const a = rows.find((r) => r.id === id);
  if (!a) return;
  openModal(`Edit box #${esc(a.box_number)} — ${esc(fullName(a))}`, `
    <div class="form-grid">
      <label>Box number<input id="f-box" value="${esc(a.box_number)}" /></label>
      <label>Lock number<input id="f-lock" value="${esc(a.lock_number)}" /></label>
      <label>Date given<input type="date" id="f-given" value="${a.date_given}" /></label>
      <label>Due for exchange<input type="date" id="f-due" value="${a.due_date}" /></label>
      <label class="full">Notes<input id="f-notes" value="${esc(a.notes || '')}" /></label>
    </div>
    <div class="form-actions">
      <button class="btn primary" id="f-save">Save changes</button>
      <button class="btn danger" id="f-delete">Delete record</button>
    </div>
  `);
  document.getElementById('f-save').onclick = async () => {
    try {
      await api(`/api/assignments/${id}`, { method: 'PUT', body: {
        box_number: val('f-box'), lock_number: val('f-lock'),
        date_given: val('f-given'), due_date: val('f-due'), notes: val('f-notes'),
      }});
      closeModal(); toast('Saved ✓'); refreshCurrentTab();
    } catch (err) { toast(err.message, true); }
  };
  document.getElementById('f-delete').onclick = async () => {
    if (!confirm('Delete this box record completely? Use “Exchange” instead if the box was returned.')) return;
    await api(`/api/assignments/${id}`, { method: 'DELETE' });
    closeModal(); toast('Record deleted'); refreshCurrentTab();
  };
}

// ---------- close / exchange ----------
async function openCloseModal(id) {
  const rows = await api('/api/assignments');
  const a = rows.find((r) => r.id === id);
  if (!a) return;
  openModal(`Exchange box #${esc(a.box_number)} — ${esc(fullName(a))}`, `
    <div class="form-grid">
      <label>What happened?
        <select id="c-outcome">
          <option value="exchanged">Box exchanged (funds collected)</option>
          <option value="returned">Box returned — donor is stopping</option>
        </select>
      </label>
      <label>Date<input type="date" id="c-date" value="${todayISO()}" /></label>
      <label>Amount collected (optional)<input type="number" step="0.01" id="c-amount" placeholder="0.00" /></label>
      <label>Notes (optional)<input id="c-notes" /></label>
    </div>
    <label class="check-row"><input type="checkbox" id="c-newbox" checked /> Donor takes a new box now</label>
    <div class="modal-section" id="c-newbox-fields">
      <div class="form-grid">
        <label>New box number<input id="c-nb-box" /></label>
        <label>New lock number<input id="c-nb-lock" /></label>
        <label class="full">New due date<input type="date" id="c-nb-due" value="${addDaysISO(todayISO(), Number(settings.cycle_days || 90))}" /></label>
      </div>
    </div>
    <div class="form-actions"><button class="btn primary" id="c-save">Confirm</button></div>
  `);
  const newboxCheck = document.getElementById('c-newbox');
  const newboxFields = document.getElementById('c-newbox-fields');
  const outcomeSel = document.getElementById('c-outcome');
  const syncNewBox = () => { newboxFields.style.display = newboxCheck.checked ? '' : 'none'; };
  newboxCheck.addEventListener('change', syncNewBox);
  outcomeSel.addEventListener('change', () => {
    newboxCheck.checked = outcomeSel.value === 'exchanged';
    syncNewBox();
  });
  document.getElementById('c-date').addEventListener('change', (e) => {
    if (e.target.value) document.getElementById('c-nb-due').value = addDaysISO(e.target.value, Number(settings.cycle_days || 90));
  });
  document.getElementById('c-save').onclick = async () => {
    try {
      const takesNew = newboxCheck.checked;
      if (takesNew && (!val('c-nb-box') || !val('c-nb-lock'))) {
        return toast('Enter the new box and lock number, or untick “Donor takes a new box”.', true);
      }
      const result = await api(`/api/assignments/${id}/close`, { method: 'POST', body: {
        outcome: outcomeSel.value,
        date_closed: val('c-date'),
        amount_collected: val('c-amount'),
        notes: val('c-notes') || undefined,
        new_box: takesNew ? { box_number: val('c-nb-box'), lock_number: val('c-nb-lock'), due_date: val('c-nb-due') } : null,
      }});
      closeModal();
      toast(result.new_assignment ? 'Box exchanged — new box registered ✓' : 'Box closed ✓');
      refreshCurrentTab();
    } catch (err) { toast(err.message, true); }
  };
}

// ---------- donors ----------
async function loadDonors() {
  const q = document.getElementById('donor-search').value;
  const rows = await api(`/api/donors?q=${encodeURIComponent(q)}`);
  const el = document.getElementById('donors-table');
  if (!rows.length) { el.innerHTML = '<div class="empty">No donors yet. Donors are added automatically when you give out a box.</div>'; return; }
  el.innerHTML = `<table><thead><tr><th>Name</th><th>Phone</th><th>Email</th><th>Boxes out</th><th>Total boxes</th><th></th></tr></thead><tbody>` +
    rows.map((d) => `<tr class="clickable" onclick="openDonorHistory(${d.id})">
      <td dir="auto"><strong>${esc(fullName(d))}</strong></td>
      <td>${esc(d.phone)}</td>
      <td>${esc(d.email) || '—'}</td>
      <td>${d.boxes_out ? `<span class="badge ok">${d.boxes_out} out</span>` : '—'}</td>
      <td>${d.total_boxes}</td>
      <td><div class="row-actions">
        <button class="btn small" onclick="event.stopPropagation(); openEditDonor(${d.id})">Edit</button>
      </div></td>
    </tr>`).join('') + '</tbody></table>';
}
document.getElementById('donor-search').addEventListener('input', () => loadDonors());

async function openDonorHistory(id) {
  const { donor, history } = await api(`/api/donors/${id}`);
  openModal(`${esc(fullName(donor))} — ${esc(donor.phone)}`, `
    ${donor.notes ? `<p class="hint">${esc(donor.notes)}</p>` : ''}
    <table><thead><tr><th>Box #</th><th>Lock #</th><th>Given</th><th>Status</th><th>Amount</th></tr></thead><tbody>
      ${history.map((a) => `<tr>
        <td>${esc(a.box_number)}</td><td>${esc(a.lock_number)}</td><td>${fmtDate(a.date_given)}</td>
        <td>${a.status === 'out' ? dueBadge(a.due_date) : `<span class="badge closed">${a.status} ${fmtDate(a.date_closed)}</span>`}</td>
        <td>${a.amount_collected != null ? '$' + Number(a.amount_collected).toLocaleString() : '—'}</td>
      </tr>`).join('')}
    </tbody></table>
    <div class="form-actions">
      <button class="btn primary" onclick='closeModal(); openNewAssignment(${JSON.stringify({ first_name: donor.first_name, last_name: donor.last_name, phone: donor.phone, email: donor.email })})'>+ Give this donor a box</button>
    </div>
  `);
}

async function openEditDonor(id) {
  const { donor } = await api(`/api/donors/${id}`);
  openModal('Edit donor', `
    <div class="form-grid">
      <label>Name<input id="d-first" dir="auto" value="${esc(donor.first_name)}" /></label>
      <label>Last name (optional)<input id="d-last" dir="auto" value="${esc(donor.last_name)}" /></label>
      <label class="full">Phone<input id="d-phone" value="${esc(donor.phone)}" /></label>
      <label class="full">Email (optional)<input id="d-email" type="email" value="${esc(donor.email || '')}" /></label>
      <label class="full">Notes<input id="d-notes" value="${esc(donor.notes || '')}" /></label>
    </div>
    <div class="form-actions"><button class="btn primary" id="d-save">Save</button></div>
  `);
  document.getElementById('d-save').onclick = async () => {
    try {
      await api(`/api/donors/${id}`, { method: 'PUT', body: {
        first_name: val('d-first'), last_name: val('d-last'), phone: val('d-phone'),
        email: val('d-email'), notes: val('d-notes'),
      }});
      closeModal(); toast('Donor updated ✓'); loadDonors();
    } catch (err) { toast(err.message, true); }
  };
}

// ---------- scan paper sheet ----------
document.getElementById('btn-scan').onclick = openScanModal;

function openScanModal() {
  openModal('Scan a sign-up sheet', `
    <p class="hint">Take a photo of the filled paper sheet (or choose one from the gallery).
      Claude will read the handwriting — Arabic and English both work. You can correct anything before saving.</p>
    <input type="file" id="scan-file" accept="image/*" capture="environment" />
    <div id="scan-status" class="hint" style="margin-top:10px"></div>
    <div id="scan-results"></div>
  `);
  document.getElementById('scan-file').addEventListener('change', handleScanFile);
}

async function handleScanFile(e) {
  const file = e.target.files[0];
  if (!file) return;
  const statusEl = document.getElementById('scan-status');
  statusEl.textContent = 'Preparing photo…';
  try {
    const { base64, mediaType } = await downscaleImage(file);
    statusEl.textContent = 'Reading the handwriting… this takes 20–60 seconds.';
    const result = await api('/api/scan', { method: 'POST', body: { image_base64: base64, media_type: mediaType } });
    statusEl.textContent = '';
    renderScanReview(result.rows || []);
  } catch (err) {
    statusEl.textContent = '';
    toast(err.message, true);
  }
}

function downscaleImage(file) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      URL.revokeObjectURL(url);
      const maxSide = 2200;
      const scale = Math.min(1, maxSide / Math.max(img.width, img.height));
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(img.width * scale);
      canvas.height = Math.round(img.height * scale);
      canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
      const dataUrl = canvas.toDataURL('image/jpeg', 0.88);
      resolve({ base64: dataUrl.split(',')[1], mediaType: 'image/jpeg' });
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Could not read that image file.')); };
    img.src = url;
  });
}

function renderScanReview(rows) {
  const el = document.getElementById('scan-results');
  if (!rows.length) {
    el.innerHTML = '<div class="empty">No filled rows were found on the sheet. Try a clearer, well-lit photo taken straight-on.</div>';
    return;
  }
  el.innerHTML = `
    <p class="hint" style="margin-top:14px"><strong>${rows.length} row${rows.length === 1 ? '' : 's'} found.</strong>
      Check and correct the details, untick any row you don't want, then save.
      Due dates will be set ${Number(settings.cycle_days || 90)} days from today.</p>
    <div class="scan-rows">
      ${rows.map((r, i) => `
        <div class="scan-row" id="scan-row-${i}">
          <label class="check-row"><input type="checkbox" id="sr-${i}-on" checked /> Row ${i + 1}</label>
          <div class="form-grid">
            <label>Name<input id="sr-${i}-first" dir="auto" value="${esc(r.first_name)}" /></label>
            <label>Last name<input id="sr-${i}-last" dir="auto" value="${esc(r.last_name)}" /></label>
            <label>Phone<input id="sr-${i}-phone" value="${esc(r.phone)}" /></label>
            <label>Email<input id="sr-${i}-email" value="${esc(r.email)}" /></label>
            <label>Box #<input id="sr-${i}-box" value="${esc(r.box_number)}" /></label>
            <label>Lock #<input id="sr-${i}-lock" value="${esc(r.lock_number)}" /></label>
          </div>
          <div class="scan-row-status" id="sr-${i}-status"></div>
        </div>`).join('')}
    </div>
    <div class="form-actions"><button class="btn primary" id="scan-save">Save boxes</button></div>
  `;
  document.getElementById('scan-save').onclick = () => saveScanRows(rows.length);
}

async function saveScanRows(count) {
  const given = todayISO();
  const due = addDaysISO(given, Number(settings.cycle_days || 90));
  let saved = 0, failed = 0;
  for (let i = 0; i < count; i++) {
    const on = document.getElementById(`sr-${i}-on`);
    const statusEl = document.getElementById(`sr-${i}-status`);
    if (!on || !on.checked) continue;
    try {
      await api('/api/assignments', { method: 'POST', body: {
        first_name: val(`sr-${i}-first`), last_name: val(`sr-${i}-last`),
        phone: val(`sr-${i}-phone`), email: val(`sr-${i}-email`),
        box_number: val(`sr-${i}-box`), lock_number: val(`sr-${i}-lock`),
        date_given: given, due_date: due,
      }});
      saved++;
      on.checked = false;
      on.disabled = true;
      statusEl.innerHTML = '<span class="badge ok">Saved ✓</span>';
    } catch (err) {
      failed++;
      statusEl.innerHTML = `<span class="badge overdue">${esc(err.message)}</span>`;
    }
  }
  if (failed === 0) {
    closeModal();
    toast(`${saved} box${saved === 1 ? '' : 'es'} registered ✓`);
  } else {
    toast(`${saved} saved, ${failed} need fixing — see the rows marked in red.`, true);
  }
  refreshCurrentTab();
}

// ---------- locations ----------
async function loadLocations() {
  locations = await api('/api/locations');
  const el = document.getElementById('locations-table');
  if (!locations.length) { el.innerHTML = '<div class="empty">No drop-off locations yet. Add the places donors can return their boxes.</div>'; return; }
  el.innerHTML = `<table><thead><tr><th>Name</th><th>Address</th><th>Hours</th><th>Status</th><th></th></tr></thead><tbody>` +
    locations.map((l) => `<tr>
      <td><strong>${esc(l.name)}</strong></td>
      <td>${esc(l.address) || '—'}</td>
      <td>${esc(l.hours) || '—'}</td>
      <td>${l.active ? '<span class="badge ok">In reminders</span>' : '<span class="badge closed">Hidden</span>'}</td>
      <td><div class="row-actions">
        <button class="btn small" onclick="openEditLocation(${l.id})">Edit</button>
        <button class="btn small" onclick="toggleLocation(${l.id}, ${l.active ? 0 : 1})">${l.active ? 'Hide' : 'Show'}</button>
        <button class="btn small danger" onclick="deleteLocation(${l.id})">Delete</button>
      </div></td>
    </tr>`).join('') + '</tbody></table>';
}

document.getElementById('btn-new-location').onclick = () => openEditLocation(null);

async function openEditLocation(id) {
  const l = id ? locations.find((x) => x.id === id) : { name: '', address: '', hours: '' };
  openModal(id ? 'Edit location' : 'Add drop-off location', `
    <div class="form-grid">
      <label class="full">Name (e.g. “Al Huda Mosque”)<input id="l-name" value="${esc(l.name)}" /></label>
      <label class="full">Address<input id="l-address" value="${esc(l.address)}" /></label>
      <label class="full">Hours / when (e.g. “Fridays after Jumu'ah”)<input id="l-hours" value="${esc(l.hours)}" /></label>
    </div>
    <div class="form-actions"><button class="btn primary" id="l-save">Save</button></div>
  `);
  document.getElementById('l-save').onclick = async () => {
    try {
      const body = { name: val('l-name'), address: val('l-address'), hours: val('l-hours') };
      if (id) await api(`/api/locations/${id}`, { method: 'PUT', body });
      else await api('/api/locations', { method: 'POST', body });
      closeModal(); toast('Location saved ✓'); loadLocations();
    } catch (err) { toast(err.message, true); }
  };
}

async function toggleLocation(id, active) {
  await api(`/api/locations/${id}`, { method: 'PUT', body: { active } });
  loadLocations();
}

async function deleteLocation(id) {
  if (!confirm('Delete this location?')) return;
  await api(`/api/locations/${id}`, { method: 'DELETE' });
  loadLocations();
}

// ---------- settings ----------
async function loadSettingsTab() {
  settings = await api('/api/settings');
  document.getElementById('set-template').value = settings.message_template || '';
  document.getElementById('set-cycle').value = settings.cycle_days || 90;
  document.getElementById('set-due-soon').value = settings.due_soon_days || 14;
  document.getElementById('set-api-key').value = settings.anthropic_api_key || '';
}

document.getElementById('btn-save-settings').onclick = async () => {
  await api('/api/settings', { method: 'PUT', body: {
    message_template: document.getElementById('set-template').value,
    cycle_days: document.getElementById('set-cycle').value,
    due_soon_days: document.getElementById('set-due-soon').value,
    anthropic_api_key: document.getElementById('set-api-key').value.trim(),
  }});
  settings = await api('/api/settings');
  const note = document.getElementById('settings-saved');
  note.hidden = false;
  setTimeout(() => (note.hidden = true), 2500);
};

document.getElementById('btn-logout').onclick = async () => {
  await api('/api/logout', { method: 'POST' });
  location.href = '/login.html';
};

// ---------- init ----------
(async function init() {
  settings = await api('/api/settings');
  locations = await api('/api/locations');
  loadDashboard();
})();
