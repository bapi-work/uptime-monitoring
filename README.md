# Uptime Monitoring

A lightweight, self-hosted uptime monitor (Uptime Kuma style) built with Node.js/Express. No native dependencies, no database server required — monitor data is stored as JSON files under `data/`.

Deploying for real use? See **[PRODUCTION.md](PRODUCTION.md)** — reverse proxy/TLS setup, required env vars, backups, updates, a pre-launch security checklist, and known limitations (single-instance only, etc).

## Features

- **Monitor types:** HTTP(S), HTTP(S) Keyword match, HTTP(S) JSON query, TCP port, DNS record, Ping (ICMP via system `ping`), WebSocket handshake
- **TLS certificate expiry monitoring** — warn/alert a configurable number of days before an HTTPS monitor's cert expires
- **Notifications:** generic Webhook, Slack, Discord, Microsoft Teams, Telegram, Email (SMTP) — attach one or more channels per monitor, fired on up/down transitions
- **Multiple public status pages** — build named, shareable pages (`/status/<slug>`) each showing a chosen subset of monitors, plus tags on monitors for organization
- **Real-time updates** over WebSocket (`/ws`) — the admin dashboard and status pages reflect status changes instantly, no polling needed (falls back to periodic refresh if the socket drops)
- **Maintenance windows** — schedule a start/end time per monitor; checks pause and the monitor shows "Maintenance" instead of "Down"
- **Event/incident history** — a log of every up/down transition per monitor, viewable from the admin dashboard
- **Two-factor authentication (TOTP)** — optional, set up from Security tab with a QR code for any authenticator app
- **Branding** — set a site name, logo, favicon, accent color, and footer text from the Branding tab; applied to the public status page(s) and login screen
- Admin login page — monitor setup/management is behind authentication; status pages stay public
- Retry-before-down logic, response time tracking, live status badges
- Status page history range toggle: Hourly (rolling last 24h) / Daily (today) / 7 / 30 / 45 / 90 Days

## Admin login

The admin dashboard (`/`) and all monitor-management API routes require login; the status page (`/status.html`) and its data stay public for anyone to view.

On first run, if no `ADMIN_USERNAME`/`ADMIN_PASSWORD` env vars are set, a random admin password is generated and printed once to the server/container logs — check there for the initial credentials:

```bash
docker compose logs | grep -A5 "First run"
```

To set known credentials from the start instead, set these before the first run (uncomment in `docker-compose.yml` or pass via `.env`):

```
ADMIN_USERNAME=admin
ADMIN_PASSWORD=your-password
SESSION_SECRET=some-long-random-string   # optional, keeps sessions valid across restarts
```

Credentials are stored (bcrypt-hashed) in `data/users.json`. Once logged in, an admin can change their password via `POST /api/change-password`.

## Run it with Docker (recommended)

```bash
docker compose up -d --build
```

- Admin dashboard: http://localhost:3300/
- Public status page: http://localhost:3300/status.html

Data is persisted in the named Docker volume `uptime-data` (mounted at `/app/data` in the container), so it survives container rebuilds/restarts. Stop it with `docker compose down` (add `-v` only if you want to wipe monitor history too).

To change the exposed port, edit the `ports` mapping in `docker-compose.yml` (left side), e.g. `8080:3300`.

## Run it without Docker

```bash
npm install
npm start
```

- Admin dashboard: http://localhost:3300/
- Public status page: http://localhost:3300/status.html

Set `PORT` to change the port.

## Notes

- Data (monitors, heartbeats, daily stats) lives in `data/` as JSON files — back that directory up if you care about history.
- Daily aggregate stats (used by the status page) are retained for 90 days; recent raw heartbeats (last 500 per monitor) are kept for the admin table.
