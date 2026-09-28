const https = require('https');
const http = require('http');
const { URL } = require('url');

function postJson(urlStr, payload) {
  return new Promise((resolve) => {
    let url;
    try {
      url = new URL(urlStr);
    } catch (e) {
      return resolve({ ok: false, error: 'Invalid URL' });
    }
    const lib = url.protocol === 'https:' ? https : http;
    const body = JSON.stringify(payload);
    const req = lib.request(
      url,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
        timeout: 10000,
      },
      (res) => {
        let respBody = '';
        res.on('data', (chunk) => {
          if (respBody.length < 2000) respBody += chunk;
        });
        res.on('end', () => {
          const ok = res.statusCode >= 200 && res.statusCode < 300;
          resolve(ok ? { ok: true } : { ok: false, error: `HTTP ${res.statusCode}: ${respBody.slice(0, 300)}` });
        });
      }
    );
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, error: 'Request timed out' }); });
    req.on('error', (err) => resolve({ ok: false, error: err.message }));
    req.write(body);
    req.end();
  });
}

function buildText(monitor, status, message) {
  const emoji = status === 'up' ? '✅' : '🔴';
  const state = status === 'up' ? 'UP' : 'DOWN';
  return `${emoji} ${monitor.name} is ${state}\n${message || ''}`;
}

async function sendWebhook(channel, monitor, status, message) {
  const url = channel.config.url;
  if (!url) return { ok: false, error: 'Webhook URL is not set' };
  return postJson(url, { monitor: monitor.name, status, message, time: new Date().toISOString() });
}

async function sendSlack(channel, monitor, status, message) {
  const url = channel.config.webhookUrl;
  if (!url) return { ok: false, error: 'Slack webhook URL is not set' };
  return postJson(url, { text: buildText(monitor, status, message) });
}

async function sendDiscord(channel, monitor, status, message) {
  const url = channel.config.webhookUrl;
  if (!url) return { ok: false, error: 'Discord webhook URL is not set' };
  return postJson(url, { content: buildText(monitor, status, message) });
}

async function sendTeams(channel, monitor, status, message) {
  const url = channel.config.webhookUrl;
  if (!url) return { ok: false, error: 'Teams webhook URL is not set' };
  const isUp = status === 'up';
  // MessageCard format, understood by Teams Incoming Webhook connectors.
  return postJson(url, {
    '@type': 'MessageCard',
    '@context': 'http://schema.org/extensions',
    summary: buildText(monitor, status, message),
    themeColor: isUp ? '2ecc71' : 'e74c3c',
    title: `${monitor.name} is ${isUp ? 'UP' : 'DOWN'}`,
    text: message || '',
    sections: [
      {
        facts: [
          { name: 'Monitor', value: monitor.name },
          { name: 'Status', value: isUp ? 'Up' : 'Down' },
          { name: 'Time', value: new Date().toISOString() },
        ],
      },
    ],
  });
}

async function sendTelegram(channel, monitor, status, message) {
  const { botToken, chatId } = channel.config;
  if (!botToken || !chatId) return { ok: false, error: 'Bot token and chat ID are required' };
  const url = `https://api.telegram.org/bot${botToken}/sendMessage`;
  return postJson(url, { chat_id: chatId, text: buildText(monitor, status, message) });
}

// Fills a {{placeholder}} template with monitor/status/message/time values.
// Falls back to the given default when the template is blank.
function renderTemplate(template, vars, fallback) {
  const text = (template || '').trim() || fallback;
  return text.replace(/\{\{\s*(\w+)\s*\}\}/g, (m, key) => (key in vars ? vars[key] : m));
}

async function sendEmail(channel, monitor, status, message) {
  const { host, port, secure, user, pass, from, to, subjectTemplate, bodyTemplate } = channel.config;
  if (!host || !to) return { ok: false, error: 'SMTP host and recipient address are required' };
  let nodemailer;
  try {
    nodemailer = require('nodemailer');
  } catch (e) {
    return { ok: false, error: 'nodemailer is not installed' };
  }
  const transporter = nodemailer.createTransport({
    host,
    port: Number(port) || 587,
    secure: !!secure,
    auth: user ? { user, pass } : undefined,
  });
  const vars = {
    monitor: monitor.name,
    status,
    statusUpper: status === 'up' ? 'UP' : 'DOWN',
    message: message || '',
    time: new Date().toISOString(),
  };
  const subject = renderTemplate(subjectTemplate, vars, `[${vars.statusUpper}] ${monitor.name}`);
  const text = renderTemplate(bodyTemplate, vars, buildText(monitor, status, message));
  try {
    await transporter.sendMail({ from: from || user, to, subject, text });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: describeSmtpError(e, host) };
  }
}

// Translates common SMTP/nodemailer failures into actionable messages instead
// of raw provider text, since "451 Authentication failed" etc. means nothing
// to someone who isn't already an SMTP expert.
function describeSmtpError(e, host) {
  const raw = e.message || String(e);
  const isSendgrid = /sendgrid/i.test(host || '');

  if (/could not authenticate|invalid login|535|534|authentication failed/i.test(raw)) {
    if (isSendgrid) {
      return `${raw} — SendGrid rejected the API key. Check: (1) the key has "Mail Send" permission (Settings > API Keys), (2) it wasn't regenerated/revoked since being saved here, (3) no extra spaces were pasted into the password field, (4) the username field is literally "apikey".`;
    }
    return `${raw} — the SMTP username/password were rejected. Double-check credentials, and that the account allows SMTP/app-password login (some providers require a separate app password when 2FA is on).`;
  }
  if (/does not match a verified sender|unverified sender|sender identity/i.test(raw)) {
    return `${raw} — the "From" address isn't verified with your email provider. Verify it (SendGrid: Settings > Sender Authentication) or use an address that's already verified.`;
  }
  if (/ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EHOSTUNREACH/i.test(raw)) {
    return `${raw} — could not reach the SMTP host/port. Check the host is correct and the port isn't blocked by your hosting provider's firewall (common with outbound 25).`;
  }
  if (/self signed certificate|certificate/i.test(raw)) {
    return `${raw} — TLS/port mismatch is a common cause: try port 465 with "secure" checked, or port 587 with it unchecked.`;
  }
  return raw;
}

const SENDERS = {
  webhook: sendWebhook,
  slack: sendSlack,
  discord: sendDiscord,
  teams: sendTeams,
  telegram: sendTelegram,
  email: sendEmail,
};

async function sendNotification(channel, monitor, status, message) {
  const sender = SENDERS[channel.type];
  if (!sender) return { ok: false, error: `Unknown notification type: ${channel.type}` };
  try {
    return await sender(channel, monitor, status, message);
  } catch (e) {
    // never let a notification failure break monitoring
    return { ok: false, error: e.message };
  }
}

async function notifyAll(channels, monitor, status, message) {
  const results = await Promise.all(
    channels.map(async (c) => ({ channel: c, result: await sendNotification(c, monitor, status, message) }))
  );
  for (const { channel, result } of results) {
    if (!result.ok) {
      console.error(
        `[notify] Failed to send ${channel.type} notification "${channel.name || channel.id}" for monitor "${monitor.name}" (${status}): ${result.error}`
      );
    }
  }
  return results;
}

async function testNotification(channel) {
  const fakeMonitor = { name: 'Test Monitor' };
  return sendNotification(channel, fakeMonitor, 'up', 'This is a test notification from Uptime Monitor.');
}

module.exports = { sendNotification, notifyAll, testNotification };
