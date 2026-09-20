const https = require('https');
const http = require('http');
const { URL } = require('url');

function postJson(urlStr, payload) {
  return new Promise((resolve) => {
    let url;
    try {
      url = new URL(urlStr);
    } catch (e) {
      return resolve(false);
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
        res.resume();
        resolve(res.statusCode >= 200 && res.statusCode < 300);
      }
    );
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.on('error', () => resolve(false));
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
  if (!url) return;
  await postJson(url, { monitor: monitor.name, status, message, time: new Date().toISOString() });
}

async function sendSlack(channel, monitor, status, message) {
  const url = channel.config.webhookUrl;
  if (!url) return;
  await postJson(url, { text: buildText(monitor, status, message) });
}

async function sendDiscord(channel, monitor, status, message) {
  const url = channel.config.webhookUrl;
  if (!url) return;
  await postJson(url, { content: buildText(monitor, status, message) });
}

async function sendTeams(channel, monitor, status, message) {
  const url = channel.config.webhookUrl;
  if (!url) return;
  const isUp = status === 'up';
  // MessageCard format, understood by Teams Incoming Webhook connectors.
  await postJson(url, {
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
  if (!botToken || !chatId) return;
  const url = `https://api.telegram.org/bot${botToken}/sendMessage`;
  await postJson(url, { chat_id: chatId, text: buildText(monitor, status, message) });
}

async function sendEmail(channel, monitor, status, message) {
  const { host, port, secure, user, pass, from, to } = channel.config;
  if (!host || !to) return;
  let nodemailer;
  try {
    nodemailer = require('nodemailer');
  } catch (e) {
    return;
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
  } catch (e) {
    // swallow — notification failures should not crash the checker
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
  if (!sender) return;
  try {
    await sender(channel, monitor, status, message);
  } catch (e) {
    // never let a notification failure break monitoring
  }
}

async function notifyAll(channels, monitor, status, message) {
  await Promise.all(channels.map((c) => sendNotification(c, monitor, status, message)));
}

module.exports = { sendNotification, notifyAll };
