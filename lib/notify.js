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

async function sendEmail(channel, monitor, status, message) {
  const { host, port, secure, user, pass, from, to } = channel.config;
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
  const subject = `[${status === 'up' ? 'UP' : 'DOWN'}] ${monitor.name}`;
  try {
    await transporter.sendMail({ from: from || user, to, subject, text: buildText(monitor, status, message) });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
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
  await Promise.all(channels.map((c) => sendNotification(c, monitor, status, message)));
}

async function testNotification(channel) {
  const fakeMonitor = { name: 'Test Monitor' };
  return sendNotification(channel, fakeMonitor, 'up', 'This is a test notification from Uptime Monitor.');
}

module.exports = { sendNotification, notifyAll, testNotification };
