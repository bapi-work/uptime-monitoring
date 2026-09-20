# Production Deployment Guide

This document covers deploying Uptime Monitor to production: hardening that's
already built in, what you still need to configure, backups, updates, and
troubleshooting.

## What's already production-hardened

These were audited and fixed as part of making this app production-ready:

| Area | Before | Now |
|---|---|---|
| Sessions | In-memory, per-process — every restart logged out every admin | Persisted to `data/sessions/` via `session-file-store`; survive restarts/redeploys |
| Session secret | Random on every boot (compounded the above) | Generated once, persisted to `data/session-secret`, or set `SESSION_SECRET` yourself |
| Ping monitor | Host value passed to a shell command (`exec`) — command injection | Uses `execFile` (no shell) + a strict hostname/IP allowlist regex |
| Container user | Ran as root | Runs as the unprivileged `node` user |
| Container health | No health check | `HEALTHCHECK` hitting `GET /healthz`; also usable by load balancers/orchestrators |
| HTTP headers | None | `X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy` on every response |
| Login brute-forcing | Unlimited attempts | Rate-limited to 20 attempts / 15 min / IP (429 after) |
| Admin password | Weak `Math.random()` generator | `crypto.randomBytes` |
| Dependencies | — | `npm audit`: 0 known vulnerabilities at time of writing |
| Shutdown | Abrupt | Handles `SIGTERM`/`SIGINT`, drains connections, 5s force-exit cap |
| Crashes | An unexpected error in a background check could crash the whole process | Top-level `uncaughtException`/`unhandledRejection` handlers log and keep monitoring running |

Frontend XSS surface was also audited: every place user-supplied text
(monitor names, tags, notification names, status page titles, branding
footer text, etc.) is inserted into the DOM, it goes through an `escapeHtml()`
helper first. IDs used in inline `onclick` handlers are server-generated
alphanumeric strings, not user input.

## Required setup before going live

### 1. Set explicit admin credentials

By default, on first boot the app generates a random admin password and
prints it once to the logs. For production, set it explicitly instead so you
don't have to go digging through logs:

```
ADMIN_USERNAME=admin
ADMIN_PASSWORD=<a strong password>
```

These only take effect on the **first** boot (when `data/users.json` doesn't
exist yet). Changing them later does nothing — change the password from the
admin UI's Security tab instead, and turn on 2FA while you're there.

### 2. Put it behind a reverse proxy with TLS

The app itself only speaks plain HTTP — something in front of it needs to
terminate TLS. `docker-compose.yml` ships with **Nginx Proxy Manager (NPM)**
wired up for this (Option A below): it's a second container with a web UI
for managing proxy hosts and requesting Let's Encrypt certificates with a
few clicks, no config files to hand-edit. If you'd rather run your own
nginx/Caddy/Traefik instead, see Option B.

Either way, once TLS is terminated in front of the app, set these two env
vars on the `uptime-monitoring` service so `req.ip` is read from
`X-Forwarded-For` correctly (needed for the login rate limiter to key on the
real client IP, not the proxy's) and session cookies are marked `Secure`:

```
TRUST_PROXY=1
COOKIE_SECURE=1
```

`docker-compose.yml` already sets `TRUST_PROXY=1` by default since NPM always
sits in front in that setup. **Don't set `COOKIE_SECURE=1` until HTTPS is
actually working end-to-end** — the browser will silently refuse to send the
cookie over plain HTTP and nobody will be able to log in. Enable it after
you've confirmed the proxy host below serves HTTPS correctly, then
`docker compose up -d` to apply it.

#### Option A: Nginx Proxy Manager (included, recommended)

1. **Point DNS first.** Create an A record for your domain (e.g.
   `status.example.com`) pointing at this server's public IP. Let's Encrypt
   needs this to resolve before it can issue a certificate.

2. **Start the stack:**

   ```bash
   docker compose up -d --build
   ```

   This starts `nginx-proxy-manager` (listening on host ports `80`, `443`,
   and `81`) and `uptime-monitoring` (no host port published — NPM reaches
   it internally at `uptime-monitoring:3300` over the `proxy-net` network
   the compose file creates; verified this resolves correctly in testing).

3. **Open the NPM admin UI** at `http://<server-ip>:81`. First visit prompts
   you to create the admin account directly (name, email, password) — there
   are no default credentials to change. **Port 81 should not be open to the
   public internet** — restrict it with a firewall rule or only reach it over
   SSH tunnel/VPN; it only needs to be reachable by you as the operator.

4. **Add a Proxy Host:** *Proxy Hosts → Add Proxy Host*
   - Domain Names: `status.example.com`
   - Scheme: `http`
   - Forward Hostname/IP: `uptime-monitoring`
   - Forward Port: `3300`
   - **Websockets Support: ON** — required for real-time status updates
     (`/ws`); without this the UI silently falls back to polling
   - Block Common Exploits: ON (optional, harmless to enable)

5. **Request the certificate:** on the same dialog's *SSL* tab, choose
   "Request a new SSL Certificate", enable "Force SSL" and "HTTP/2 Support",
   agree to the Let's Encrypt ToS, and Save.

6. **Confirm it worked:** visit `https://status.example.com/healthz` — you
   should get `{"ok":true}` over a valid certificate. Then enable
   `COOKIE_SECURE=1` in `docker-compose.yml` for the `uptime-monitoring`
   service and run `docker compose up -d` to apply it.

#### Option B: your own reverse proxy

Skip the `nginx-proxy-manager` service in `docker-compose.yml` (or remove it)
and publish `uptime-monitoring`'s port instead (uncomment the `ports:` block
under that service), then point your own proxy at `localhost:3300`.

Example with Caddy (simplest option, automatic HTTPS):

```
status.example.com {
    reverse_proxy localhost:3300
}
```

Example with nginx:

```nginx
server {
    listen 443 ssl http2;
    server_name status.example.com;

    ssl_certificate     /etc/letsencrypt/live/status.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/status.example.com/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:3300;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    location /ws {
        proxy_pass http://127.0.0.1:3300;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
    }
}
```

### 3. Set a persistent session secret (optional but recommended)

The app will generate and persist one automatically on first boot
(`data/session-secret`), which is enough as long as that file lives in your
persistent volume. If you'd rather manage it explicitly (e.g. to share it
across a redeploy that recreates the volume, or because your secrets
management policy requires it), set:

```
SESSION_SECRET=<64+ random hex/base64 characters>
```

Generate one with: `openssl rand -hex 48`

## Deploying with Docker Compose

```bash
git clone <this repo> && cd uptime-monitoring
cp docker-compose.yml docker-compose.override.yml   # optional, for local env overrides
```

Edit `docker-compose.yml` (or an override file) to set your env vars, then:

```bash
docker compose up -d --build
```

Check it's healthy:

```bash
docker compose ps                 # STATUS column should show "healthy" after ~10s
docker compose exec uptime-monitoring wget -qO- http://localhost:3300/healthz
docker compose logs -f --tail 50
```

(`uptime-monitoring` has no host port published by default — see Option A
above — so `/healthz` is checked from inside the container, or externally via
`https://status.example.com/healthz` once the proxy host is set up.)

### Upgrading an existing deployment to this hardened version

If you're updating from a version that ran as root (pre-hardening), the
named volume's files are already owned by root, and the new image runs as an
unprivileged user — it won't be able to write to them. Fix once, before
redeploying:

```bash
docker run --rm -v uptime-monitoring_uptime-data:/data alpine chown -R 1000:1000 /data
docker compose up -d --build
```

(Replace `uptime-monitoring_uptime-data` with your actual volume name —
check with `docker volume ls` if you're not sure. A brand-new deployment with
an empty volume does not need this step.)

## Backups

Everything the app knows — monitors, notification channels, status pages,
branding, admin credentials, heartbeat/daily/hourly history, sessions — lives
under `/app/data` in the named volume, as plain JSON files. Back up the whole
directory; there's no database to dump separately.

```bash
# Snapshot to a tarball on the host
docker run --rm -v uptime-monitoring_uptime-data:/data -v "$PWD":/backup alpine \
  tar czf /backup/uptime-monitor-backup-$(date +%F).tar.gz -C /data .

# Restore into a fresh volume
docker run --rm -v uptime-monitoring_uptime-data:/data -v "$PWD":/backup alpine \
  sh -c "cd /data && tar xzf /backup/uptime-monitor-backup-2026-09-20.tar.gz"
```

Automate the snapshot command on a cron/scheduled task; retention and
off-host copies are on you (a simple approach: nightly snapshot + `rclone` or
`rsync` to remote storage).

If you're using the included Nginx Proxy Manager, also back up its two
volumes (`uptime-monitoring_npm-data` and `uptime-monitoring_npm-letsencrypt`)
the same way — they hold your proxy host configuration and issued
certificates, so restoring them saves you from redoing that setup /
re-requesting certificates after a disaster recovery.

## Updating the app

```bash
git pull
docker compose up -d --build
```

The container restarts, sessions and all monitor data persist (see the
hardening table above — this was the point of fixing the session-store
issue). Check `docker compose logs -f` and `/healthz` after each update.

## Monitoring the monitor

This app doesn't monitor itself. Options, roughly in order of effort:

- Point an external check (a different uptime tool, your cloud provider's
  health check, or a cron job with `curl -f`) at `GET /healthz`. It returns
  `200 {"ok":true}` with no auth required, and is also what Docker's own
  `HEALTHCHECK` uses.
- Watch container restarts: `docker inspect uptime-monitoring --format
  '{{.RestartCount}}'`.
- Ship container logs (`docker compose logs`) to wherever you already
  centralize logs — the app logs to stdout/stderr only, nothing to a file,
  so any standard Docker logging driver works. `docker-compose.yml` already
  caps log file size/rotation via the `json-file` driver settings.

## Security checklist before you call it done

- [ ] `ADMIN_PASSWORD` set to something you chose, not left to autogenerate (or autogenerated password saved somewhere safe and the log line cleared)
- [ ] 2FA turned on for the admin account (Security tab)
- [ ] TLS terminated in front of the app (reverse proxy or LB), `TRUST_PROXY=1` and `COOKIE_SECURE=1` set
- [ ] `/api/branding`, `/api/status`, `/api/status/:id`, and any `/status/<slug>` page you don't intend to be public are reviewed — **the default `/status.html` always shows every monitor to anyone**; if a monitor shouldn't be publicly visible at all, this app doesn't currently support that (see Limitations below) — don't create it, or run a second private instance
- [ ] Volume backups scheduled and tested (a restore you haven't tried is not a backup)
- [ ] Notification channel secrets (SMTP passwords, bot tokens, webhook URLs) are only ever returned by authenticated `/api/notifications` — verified in this audit, don't re-expose them by proxying that response somewhere public
- [ ] Only one instance is running against a given data volume (see Limitations)
- [ ] If using the included Nginx Proxy Manager: port `81` (its admin UI) is firewalled off from the public internet, and its own admin account uses a real password, not left on whatever was set during the rushed first-run screen

## Limitations (by design, not bugs)

- **Single instance only.** Storage is local JSON files, sessions are a local
  file store, real-time updates are an in-process WebSocket server. Running
  multiple replicas against the same volume, or behind a load balancer that
  doesn't use sticky sessions, will cause data races and broken sessions.
  Vertical scaling (a bigger box) is fine; horizontal scaling is not
  supported without a rearchitecture (external DB, shared session store,
  pub/sub for the WebSocket layer).
- **No per-monitor public/private visibility control.** Any monitor that
  exists is visible via the default `/status.html`/`/api/status`. Named
  status pages (`/status/<slug>`) let you curate a *subset* for a shareable
  link, but the underlying `/api/status/:id` endpoint will still answer for
  any monitor ID if someone has (or guesses) it. Don't run this as a single
  instance for both "monitors the public should see" and "monitors that must
  stay internal" — use a separate instance for the internal ones.
- **Ping monitors shell out to the OS `ping` binary** (sandboxed against
  injection, per the hardening table above, but still a process spawn per
  check). Fine at normal monitor counts/intervals; if you're running
  hundreds of ping monitors at short intervals, watch host process load.
- **No built-in log rotation for `data/heartbeats` growth beyond the app's
  own retention** (500 raw heartbeats/monitor, 90 days daily, 50 hours
  hourly, 200 events — all already capped). Nothing to do here, just noting
  it's bounded by design, not unbounded.

## Troubleshooting

**Container is "unhealthy" after startup.** Check `docker compose logs`.
The most common cause after upgrading is the volume-permissions issue
described above — an `EACCES` on `/app/data/...` means the volume needs the
one-time `chown` fix.

**Nobody can log in over HTTPS.** Check whether `COOKIE_SECURE=1` is set
without TLS actually reaching the app (either no reverse proxy, or the proxy
isn't forwarding `X-Forwarded-Proto`). The browser won't send a `Secure`
cookie over plain HTTP; if your proxy setup can't be confirmed to add TLS
end-to-end, leave `COOKIE_SECURE` unset.

**Getting 429s on login.** You've hit the rate limiter (20 attempts / 15 min
per IP). Legitimate case: everyone in an office shares one outbound IP. Wait
out the window, or if this is a recurring problem, it means the app is being
used by more concurrent admins than a single shared-IP rate limit
anticipates — worth revisiting the limiter's `max` in `server.js` for your
situation.

**Real-time status updates aren't showing up (page needs manual refresh).**
Confirm your reverse proxy forwards WebSocket upgrades for the `/ws` path.
In Nginx Proxy Manager, edit the Proxy Host and make sure **Websockets
Support** is toggled on (it's off by default, and it's the single most
common cause of this). With a hand-written nginx config, see the `/ws`
`location` block in the example above — it needs its own block with the
`Upgrade`/`Connection` headers. The UI falls back to polling if the socket
can't connect, so this degrades gracefully but isn't real-time.

**Forgot the admin password and 2FA is off.** Stop the container, edit
`data/users.json` directly (it's a small file — remove the `passwordHash`
field's protection by setting `ADMIN_PASSWORD` env var only works on first
boot, so instead: delete `data/users.json` to force regeneration on next
boot, which will print a fresh random password to the logs). This deletes
the old password hash; if 2FA was on, it also gets cleared since it lived in
the same file, so you'll need to re-enroll it after logging in.
