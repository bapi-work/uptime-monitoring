const otplib = require('otplib');
const QRCode = require('qrcode');
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const USERS_FILE = path.join(DATA_DIR, 'users.json');

function readUser() {
  return JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));
}

function writeUser(user) {
  fs.writeFileSync(USERS_FILE, JSON.stringify(user, null, 2));
}

async function generateSetupQrCode(username) {
  const secret = await otplib.generateSecret();
  const otpauth = otplib.generateURI({ issuer: 'Uptime Monitor', label: username, secret });
  const user = readUser();
  user.twoFactorPendingSecret = secret;
  writeUser(user);
  const qrDataUrl = await QRCode.toDataURL(otpauth);
  return { secret, qrDataUrl };
}

async function confirmSetup(token) {
  const user = readUser();
  if (!user.twoFactorPendingSecret) return { ok: false, error: 'No pending 2FA setup' };
  const result = await otplib.verify({ token: String(token || ''), secret: user.twoFactorPendingSecret });
  if (!result || !result.valid) return { ok: false, error: 'Invalid code' };
  user.twoFactorSecret = user.twoFactorPendingSecret;
  user.twoFactorEnabled = true;
  delete user.twoFactorPendingSecret;
  writeUser(user);
  return { ok: true };
}

function disable() {
  const user = readUser();
  user.twoFactorEnabled = false;
  delete user.twoFactorSecret;
  delete user.twoFactorPendingSecret;
  writeUser(user);
  return { ok: true };
}

async function verifyToken(token) {
  const user = readUser();
  if (!user.twoFactorEnabled || !user.twoFactorSecret) return true;
  const result = await otplib.verify({ token: String(token || ''), secret: user.twoFactorSecret });
  return !!(result && result.valid);
}

function isEnabled() {
  const user = readUser();
  return !!user.twoFactorEnabled;
}

module.exports = { generateSetupQrCode, confirmSetup, disable, verifyToken, isEnabled };
