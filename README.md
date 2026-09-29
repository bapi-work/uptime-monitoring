# Uptime Monitoring

A lightweight, self-hosted uptime monitor (Uptime Kuma style) built with Node.js/Express. No native dependencies, no database server required — monitor data is stored as JSON files under `data/`.

Deploying for real use? See **[PRODUCTION.md](PRODUCTION.md)** — reverse proxy/TLS setup, required env vars, backups, updates, a pre-launch security checklist, and known limitations (single-instance only, etc).

Setting up alerts? See **[docs/NOTIFICATIONS.md](docs/NOTIFICATIONS.md)** — step-by-step setup for Webhook, Slack, Discord, Teams, Telegram, and Email (SMTP), including provider-specific notes (SendGrid, Gmail, Microsoft 365) and troubleshooting.

## Features

- **Monitor types:** HTTP(S), HTTP(S) Keyword match, HTTP(S) JSON query, TCP port, DNS record, Ping (ICMP via system `ping`), WebSocket handshake
- **TLS certificate expiry monitoring** — warn/alert a configurable number of days before an HTTPS monitor's cert expires
- **Notifications:** generic Webhook, Slack, Discord, Microsoft Teams, Telegram, Email (SMTP) — attach one or more channels per monitor, fired on up/down transitions
- **Multiple public status pages** — build named, shareable pages (`/status/<slug>`) each showing a chosen subset of monitors; admins control which pages appear on the public home page via a public/private toggle
- **Public home page** (`/`) — landing page listing all status pages marked "publish"; anyone can browse without login
- **Real-time updates** over WebSocket (`/ws`) — the admin dashboard and status pages reflect status changes instantly, no polling needed (falls back to periodic refresh if the socket drops)
- **Maintenance windows** — schedule a start/end time per monitor; checks pause and the monitor shows "Maintenance" instead of "Down"
- **Event/incident history** — a log of every up/down transition per monitor, viewable from the admin dashboard
- **Two-factor authentication (TOTP)** — optional, set up from Security tab with a QR code for any authenticator app
- **Branding** — set a site name, logo, favicon, accent color, and footer text from the Branding tab; applied to the public status page(s) and login screen
- **User roles** — Admin (full access), Manager (create/edit, no delete), User (read-only); manage accounts from the admin-only Users tab
- **Admin dashboard** (`/admin`) — requires login; all monitor setup, management, and user administration is here
- **Authentication** — login page at `/login`; all status pages remain public and accessible via direct URL regardless of listing
- Retry-before-down logic, response time tracking, live status badges
- Status page history range toggle: Hourly (rolling last 24h) / Daily (today) / 7 / 30 / 45 / 90 Days

## Admin login

The admin dashboard (`/admin`) and all monitor-management API routes require authentication. The public home page (`/`) and status pages (`/status/<slug>`) are open to anyone.

**First-run setup:**

If `ADMIN_USERNAME` and `ADMIN_PASSWORD` are not set before first run, a random admin password is generated and printed to the server logs. Retrieve it with:

```bash
# Docker
docker compose logs uptime-monitoring | grep -i "admin\|password\|first run"

# Local dev
# Check console output where you ran npm start
```

**Set known credentials before first run:**

Edit `docker-compose.yml` or `.env` (uncomment the environment section):

```yaml
environment:
  ADMIN_USERNAME: admin
  ADMIN_PASSWORD: your-secure-password
  SESSION_SECRET: some-long-random-string   # optional; keeps sessions valid across restarts
```

Or via CLI:
```bash
ADMIN_USERNAME=admin ADMIN_PASSWORD=yourpassword docker compose up -d --build
```

Credentials are stored bcrypt-hashed in `data/users.json`.

## Password resets

**A logged-in user changing their own password:** Security tab → "Change password".

**An admin resetting another user's password:** Users tab → "Reset Password" next to
that user. This works for admin, manager, and user accounts alike, and doesn't
require knowing the old password.

**If the only admin account is locked out** (forgot the password, lost the 2FA
device, etc.) and nobody can log in at all, use the recovery script — it edits
`data/users.json` directly, no login required, and also clears 2FA on that account
so a lost authenticator can't cause a double lockout:

```bash
# Docker
docker compose exec uptime-monitoring node scripts/reset-admin-password.js <new-password>

# Local dev
npm run reset-admin-password -- <new-password>
```

By default it resets the first admin account found. To target a specific username
(e.g. if you have multiple admins), pass it as a second argument:

```bash
docker compose exec uptime-monitoring node scripts/reset-admin-password.js <new-password> <username>
```

Password must be at least 6 characters. This is safer than deleting
`data/users.json` — that would also destroy every other user account (manager/user)
and everyone's 2FA settings, not just the admin's.

## Run it with Docker (recommended)

```bash
docker compose up -d --build
```

**URLs:**
- **Public home page:** http://localhost:3300/ (lists published status pages)
- **Admin dashboard:** http://localhost:3300/admin (requires login)
- **Login:** http://localhost:3300/login
- **Status pages:** http://localhost:3300/status/<slug> (public, accessible with or without login)

Data is persisted in the named Docker volume `uptime-data` (mounted at `/app/data` in the container), so it survives container rebuilds/restarts. Stop it with `docker compose down` (add `-v` only if you want to wipe monitor history too).

To change the exposed port, edit the `ports` mapping in `docker-compose.yml` (left side), e.g. `8080:3300`.

## Run it without Docker

```bash
npm install
npm start
```

Or with admin credentials:
```bash
ADMIN_USERNAME=admin ADMIN_PASSWORD=yourpassword npm start
```

**URLs:**
- **Public home page:** http://localhost:3300/
- **Admin dashboard:** http://localhost:3300/admin
- **Login:** http://localhost:3300/login
- **Status pages:** http://localhost:3300/status/<slug>

Set `PORT` to change the port, e.g. `PORT=8080 npm start`.

## Notes

- Data (monitors, heartbeats, daily stats) lives in `data/` as JSON files — back that directory up if you care about history.
- Daily aggregate stats (used by the status page) are retained for 90 days; recent raw heartbeats (last 500 per monitor) are kept for the admin table.
