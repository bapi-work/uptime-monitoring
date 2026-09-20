const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');

const DATA_DIR = path.join(__dirname, '..', 'data');
const USERS_FILE = path.join(DATA_DIR, 'users.json');

function ensureAdmin() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (fs.existsSync(USERS_FILE)) return;

  const username = process.env.ADMIN_USERNAME || 'admin';
  const password = process.env.ADMIN_PASSWORD || generatePassword();
  const passwordHash = bcrypt.hashSync(password, 10);

  fs.writeFileSync(USERS_FILE, JSON.stringify({ username, passwordHash }, null, 2));

  if (!process.env.ADMIN_PASSWORD) {
    console.log('==================================================');
    console.log(' First run: created default admin account');
    console.log(` Username: ${username}`);
    console.log(` Password: ${password}`);
    console.log(' Please log in and note these down. To set your');
    console.log(' own credentials instead, set ADMIN_USERNAME and');
    console.log(' ADMIN_PASSWORD env vars before first run.');
    console.log('==================================================');
  }
}

function generatePassword() {
  return crypto.randomBytes(12).toString('base64url');
}

function getUser() {
  ensureAdmin();
  return JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));
}

function verifyLogin(username, password) {
  const user = getUser();
  if (!user || user.username !== username) return false;
  return bcrypt.compareSync(password || '', user.passwordHash);
}

function changePassword(currentPassword, newPassword) {
  const user = getUser();
  if (!bcrypt.compareSync(currentPassword || '', user.passwordHash)) {
    return { ok: false, error: 'Current password is incorrect' };
  }
  if (!newPassword || newPassword.length < 6) {
    return { ok: false, error: 'New password must be at least 6 characters' };
  }
  user.passwordHash = bcrypt.hashSync(newPassword, 10);
  fs.writeFileSync(USERS_FILE, JSON.stringify(user, null, 2));
  return { ok: true };
}

module.exports = { ensureAdmin, getUser, verifyLogin, changePassword };
