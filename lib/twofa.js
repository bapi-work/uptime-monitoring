const otplib = require('otplib');
const QRCode = require('qrcode');
const users = require('./users');

function getMutableUsers() {
  return users.getUsers();
}

async function generateSetupQrCode(userId, username) {
  const secret = await otplib.generateSecret();
  const otpauth = otplib.generateURI({ issuer: 'Uptime Monitor', label: username, secret });
  const list = getMutableUsers();
  const idx = list.findIndex((u) => u.id === userId);
  if (idx === -1) throw new Error('User not found');
  list[idx].twoFactorPendingSecret = secret;
  users.writeUsers(list);
  const qrDataUrl = await QRCode.toDataURL(otpauth);
  return { secret, qrDataUrl };
}

async function confirmSetup(userId, token) {
  const list = getMutableUsers();
  const idx = list.findIndex((u) => u.id === userId);
  if (idx === -1) return { ok: false, error: 'User not found' };
  const user = list[idx];
  if (!user.twoFactorPendingSecret) return { ok: false, error: 'No pending 2FA setup' };
  const result = await otplib.verify({ token: String(token || ''), secret: user.twoFactorPendingSecret });
  if (!result || !result.valid) return { ok: false, error: 'Invalid code' };
  user.twoFactorSecret = user.twoFactorPendingSecret;
  user.twoFactorEnabled = true;
  delete user.twoFactorPendingSecret;
  users.writeUsers(list);
  return { ok: true };
}

function disable(userId) {
  const list = getMutableUsers();
  const idx = list.findIndex((u) => u.id === userId);
  if (idx === -1) return { ok: false, error: 'User not found' };
  list[idx].twoFactorEnabled = false;
  delete list[idx].twoFactorSecret;
  delete list[idx].twoFactorPendingSecret;
  users.writeUsers(list);
  return { ok: true };
}

async function verifyToken(userId, token) {
  const user = users.getUserById(userId);
  if (!user || !user.twoFactorEnabled || !user.twoFactorSecret) return true;
  const result = await otplib.verify({ token: String(token || ''), secret: user.twoFactorSecret });
  return !!(result && result.valid);
}

function isEnabled(userId) {
  const user = users.getUserById(userId);
  return !!(user && user.twoFactorEnabled);
}

module.exports = { generateSetupQrCode, confirmSetup, disable, verifyToken, isEnabled };
