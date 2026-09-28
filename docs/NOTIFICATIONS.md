# Setting up notification channels

Notification channels are configured in the admin dashboard under **Notifications**.
Each channel is created once and can then be attached to any monitor (Monitors tab →
Add/Edit Monitor → "Notify via"). A monitor only sends alerts through the channels
you select for it.

All channels fire on **up → down** and **down → up** transitions (not on every check).

---

## Webhook (generic)

Sends a JSON POST to a URL of your choice:

```json
{ "monitor": "My website", "status": "down", "message": "HTTP 500", "time": "2026-...Z" }
```

**Setup**
1. Type: `Webhook`
2. Webhook URL: your endpoint (must accept `POST` with a JSON body)

Use this for any custom integration (internal alerting system, PagerDuty inbound
webhook, a serverless function, etc.) that doesn't have a dedicated type below.

---

## Slack

1. Create a Slack app (or reuse one) at https://api.slack.com/apps → **Incoming Webhooks** → enable → **Add New Webhook to Workspace** → pick the channel.
2. Copy the generated URL (`https://hooks.slack.com/services/...`).
3. In the admin dashboard: Type `Slack`, paste the URL into **Slack Webhook URL**.

---

## Discord

1. In your Discord server: Channel settings → **Integrations** → **Webhooks** → **New Webhook**.
2. Copy the **Webhook URL**.
3. In the admin dashboard: Type `Discord`, paste it into **Discord Webhook URL**.

---

## Microsoft Teams

1. In the target Teams channel: **⋯** → **Connectors** (or **Workflows** on newer tenants) → **Incoming Webhook** → configure → copy the URL.
2. In the admin dashboard: Type `Teams`, paste it into **Teams Incoming Webhook URL**.

> Microsoft is migrating Teams from classic Connectors to Workflows in some tenants.
> If classic Incoming Webhook isn't available, use the Workflows "When a webhook
> request is received" template instead — it accepts the same style of POST.

---

## Telegram

1. Message **@BotFather** on Telegram → `/newbot` → follow the prompts → copy the **bot token**.
2. Add the bot to the target group/channel (or start a DM with it), then get the
   **chat ID**:
   - For a group: add the bot, send any message, then visit
     `https://api.telegram.org/bot<TOKEN>/getUpdates` and read `"chat":{"id": ...}`.
   - For a DM: message the bot first, then use the same `getUpdates` call.
3. In the admin dashboard: Type `Telegram`, fill in **Bot Token** and **Chat ID**.

---

## Email (SMTP)

**Setup**
| Field | Notes |
|---|---|
| SMTP Host | e.g. `smtp.sendgrid.net`, `smtp.gmail.com`, `smtp.office365.com` |
| SMTP Port | `587` (STARTTLS, most common) or `465` (implicit TLS — check "secure") |
| SMTP Username | provider-specific — see below |
| SMTP Password | provider-specific — see below |
| From address | must usually be a verified sender for the provider |
| To address | where alerts are delivered |
| Subject template *(optional)* | see placeholders below |
| Body template *(optional)* | see placeholders below |

### Provider-specific notes

**SendGrid**
- Username is literally the string `apikey` (not your account name).
- Password is a SendGrid **API key** with **Mail Send** permission (Settings → API Keys).
- The **From** address must be a verified Sender Identity (Settings → Sender Authentication) — SendGrid rejects sends from unverified senders.
- Host: `smtp.sendgrid.net`, Port: `587` (or `2525` as a fallback if 587 is blocked).

**Gmail / Google Workspace**
- Requires an **App Password** (Google Account → Security → 2-Step Verification → App passwords) — your normal password will not work if 2FA is enabled, and Google blocks plain "less secure app" access by default now.
- Host: `smtp.gmail.com`, Port: `587`.

**Microsoft 365 / Outlook**
- Host: `smtp.office365.com`, Port: `587`.
- May require SMTP AUTH to be explicitly enabled for the mailbox by an admin (Exchange Admin Center → mailbox → "Authenticated SMTP").

### Subject / body templates

Leave both blank to use the built-in default (`[UP]`/`[DOWN] <monitor name>`).
To customize, use these placeholders — they get substituted at send time:

| Placeholder | Example value |
|---|---|
| `{{monitor}}` | `My website` |
| `{{status}}` | `up` or `down` |
| `{{statusUpper}}` | `UP` or `DOWN` |
| `{{message}}` | `HTTP 500`, `Connection timed out`, etc. |
| `{{time}}` | ISO timestamp of the check |

Example:

```
Subject: 🚨 {{statusUpper}} — {{monitor}}

Body:
Monitor: {{monitor}}
Status: {{statusUpper}}
Details: {{message}}
Checked at: {{time}}
```

### Testing a channel

After filling in the fields (before or after saving), click **Send Test** — it sends
a real test notification immediately and shows the result (success or the exact
provider error) without waiting for a monitor to actually change status.

### Troubleshooting common SMTP errors

| Error contains | Likely cause |
|---|---|
| `Invalid login` / `535` / `451 Authentication failed` | Wrong username/password, or (SendGrid) API key missing Mail Send permission / revoked |
| `does not match a verified Sender Identity` | From address isn't verified with the provider |
| `ECONNREFUSED` / `ETIMEDOUT` | Wrong host/port, or the port is blocked by your hosting provider's firewall (common with outbound 25) |
| `self signed certificate` / certificate errors | Port/`secure` mismatch — try 465 with "secure" checked, or 587 unchecked |

The app now logs any notification failure (not just email) to the server console
with the channel name, monitor, and the provider's exact error — check
`docker compose logs -f uptime-monitoring` (or your process logs) if a "Send Test"
succeeds but a real alert during an actual outage seems to have gone missing.
