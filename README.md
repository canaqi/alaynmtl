# Al Ayn — Sadaqa Box Tracker

A simple system for tracking Sadaqa boxes given to donors, and reminding them
by WhatsApp when their box is due for exchange.

## Start the app

```bash
node server.js
```

Then open **http://localhost:3040** in your browser.

When the server starts, it also prints a second address (e.g. `http://192.168.1.x:3040`).
Anyone on the **same WiFi network** can open that address to use the system —
that's how the rest of the team accesses it while the server is running on your computer.

No installation is needed — only Node.js (already installed).

## How it works

- **Give out a box** (Boxes tab): enter the donor's name (Arabic or English —
  last name and email are optional), phone (with country code), the box number
  and lock number. The due date is set automatically 3 months later (changeable
  per box, and the default cycle is changeable in Settings).
- **Paper sign-up sheet**: the **🖨 Sign-up sheet** button opens a printable
  A4 table (English + Arabic) for people to fill in by hand at a centre.
  Afterwards, open the app on a phone, press **📷 Scan sheet**, and photograph
  the filled sheet — Claude AI reads the handwriting (Arabic and English) and
  shows every row for you to check and correct before saving.
  This needs a Claude API key in Settings (from console.anthropic.com; each
  scan costs a few cents).
- **Dashboard**: shows overdue boxes and boxes due soon. Each row has a
  **WhatsApp** button — it opens WhatsApp with the reminder message pre-filled,
  so you just press send. The system records when a donor was last reminded.
- **Exchange**: when a donor returns/exchanges a box, click **Exchange**, optionally
  record the amount collected, and register the new box they take in the same step.
- **Drop Locations**: the drop-off locations you add here are automatically
  listed inside the WhatsApp reminder message.
- **Settings**: edit the reminder message (any language), the exchange cycle,
  and the "due soon" window.

## Logo

The app ships with an approximation of the Al Ayn mark. To use the official
logo, save the logo image as `public/logo.png` — the app and the printable
sheet pick it up automatically.

## Your data

Everything is stored in a single file: `data/sadaqa.db`.
**Back it up regularly** — copying that one file (while the server is stopped)
is a complete backup.

## Going live (cloud hosting on Railway)

The app is ready to deploy — it has a team password, HTTPS-aware sessions,
a Dockerfile, and a persistent-volume database path.

1. **Create accounts** (one-time): [github.com](https://github.com) and
   [railway.com](https://railway.com) (sign in with GitHub; the Hobby plan
   is ~$5/month).
2. **Push this folder to a private GitHub repository** (ask Claude to do
   this step for you).
3. In Railway: **New Project → Deploy from GitHub repo** → pick the repo.
   Railway detects the Dockerfile automatically.
4. In the service settings:
   - **Volumes → Add volume**, mount path: `/data` (this is where the
     database lives — without it, data is lost on redeploy).
   - **Networking → Generate Domain** → choose port `3040`.
5. Open the generated `https://…up.railway.app` address. On first visit the
   app asks you to **create the team password**. Then add the Claude API key
   and drop locations in Settings.
6. Share the address and password with the team — it now works from any
   phone, anywhere.

**Backups in the cloud:** use **Settings → Download backup** regularly and
keep the file in Google Drive or similar.
