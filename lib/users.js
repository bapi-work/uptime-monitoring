const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');

const DATA_DIR = path.join(__dirname, '..', 'data');
const USERS_FILE = path.join(DATA_DIR, 'users.json');

const ROLES = ['admin', 'manager', 'user'];

function newId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function generatePassword() {
  return crypto.randomBytes(12).toString('base64url');
}

function readRaw() {
  try {
    return JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));
  } catch (e) {
    return null;
  }
}

function writeUsers(users) {
  const tmp = USERS_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(users, null, 2));
  fs.renameSync(tmp, USERS_FILE);
}

// Ensures data/users.json exists and is in the current (array-of-users)
// format. Transparently migrates the old single-admin object format
// ({username, passwordHash, ...}) used before multi-user support, so an
// existing deployment's login keeps working across the upgrade with no
// manual steps.
function ensureAdmin() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

  if (!fs.existsSync(USERS_FILE)) {
    const username = process.env.ADMIN_USERNAME || 'admin';
    const password = process.env.ADMIN_PASSWORD || generatePassword();
    const passwordHash = bcrypt.hashSync(password, 10);
    writeUsers([{ id: newId(), username, passwordHash, role: 'admin', createdAt: new Date().toISOString() }]);

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
    return;
  }

  const raw = readRaw();
  if (!Array.isArray(raw) && raw && raw.username) {
    // Old single-admin object format — migrate in place, preserving the
    // existing password hash and 2FA state so nobody gets logged out.
    const migrated = [
      {
        id: newId(),
        username: raw.username,
        passwordHash: raw.passwordHash,
        role: 'admin',
        twoFactorEnabled: raw.twoFactorEnabled || false,
        twoFactorSecret: raw.twoFactorSecret,
        createdAt: new Date().toISOString(),
      },
    ];
    writeUsers(migrated);
    console.log('Migrated data/users.json from single-admin format to multi-user format.');
  }
}

function getUsers() {
  ensureAdmin();
  return readRaw() || [];
}

// Public-safe list: no password hashes or 2FA secrets.
function listUsers() {
  return getUsers().map(({ id, username, role, twoFactorEnabled, createdAt }) => ({
    id,
    username,
    role,
    twoFactorEnabled: !!twoFactorEnabled,
    createdAt,
  }));
}

function getUserById(id) {
  return getUsers().find((u) => u.id === id) || null;
}

function getUserByUsername(username) {
  return getUsers().find((u) => u.username === username) || null;
}

function verifyLogin(username, password) {
  const user = getUserByUsername(username);
  if (!user) return null;
  return bcrypt.compareSync(password || '', user.passwordHash) ? user : null;
}

function countAdmins(users) {
  return users.filter((u) => u.role === 'admin').length;
}

function createUser({ username, password, role }) {
  if (!username || !password) return { ok: false, error: 'Username and password are required' };
  if (password.length < 6) return { ok: false, error: 'Password must be at least 6 characters' };
  if (!ROLES.includes(role)) return { ok: false, error: 'Invalid role' };
  const users = getUsers();
  if (users.some((u) => u.username.toLowerCase() === username.toLowerCase())) {
    return { ok: false, error: 'Username already exists' };
  }
  const user = {
    id: newId(),
    username,
    passwordHash: bcrypt.hashSync(password, 10),
    role,
    createdAt: new Date().toISOString(),
  };
  users.push(user);
  writeUsers(users);
  return { ok: true, user: { id: user.id, username: user.username, role: user.role } };
}

function updateUserRole(id, role) {
  if (!ROLES.includes(role)) return { ok: false, error: 'Invalid role' };
  const users = getUsers();
  const idx = users.findIndex((u) => u.id === id);
  if (idx === -1) return { ok: false, error: 'User not found' };
  if (users[idx].role === 'admin' && role !== 'admin' && countAdmins(users) <= 1) {
    return { ok: false, error: 'Cannot remove the last admin account\'s admin role' };
  }
  users[idx].role = role;
  writeUsers(users);
  return { ok: true };
}

function adminResetPassword(id, newPassword) {
  if (!newPassword || newPassword.length < 6) return { ok: false, error: 'Password must be at least 6 characters' };
  const users = getUsers();
  const idx = users.findIndex((u) => u.id === id);
  if (idx === -1) return { ok: false, error: 'User not found' };
  users[idx].passwordHash = bcrypt.hashSync(newPassword, 10);
  writeUsers(users);
  return { ok: true };
}

function deleteUser(id, requestingUserId) {
  const users = getUsers();
  const target = users.find((u) => u.id === id);
  if (!target) return { ok: false, error: 'User not found' };
  if (id === requestingUserId) return { ok: false, error: 'You cannot delete your own account' };
  if (target.role === 'admin' && countAdmins(users) <= 1) {
    return { ok: false, error: 'Cannot delete the last admin account' };
  }
  writeUsers(users.filter((u) => u.id !== id));
  return { ok: true };
}

function changePassword(userId, currentPassword, newPassword) {
  const users = getUsers();
  const idx = users.findIndex((u) => u.id === userId);
  if (idx === -1) return { ok: false, error: 'User not found' };
  if (!bcrypt.compareSync(currentPassword || '', users[idx].passwordHash)) {
    return { ok: false, error: 'Current password is incorrect' };
  }
  if (!newPassword || newPassword.length < 6) {
    return { ok: false, error: 'New password must be at least 6 characters' };
  }
  users[idx].passwordHash = bcrypt.hashSync(newPassword, 10);
  writeUsers(users);
  return { ok: true };
}

module.exports = {
  ROLES,
  ensureAdmin,
  getUsers,
  listUsers,
  getUserById,
  getUserByUsername,
  verifyLogin,
  createUser,
  updateUserRole,
  adminResetPassword,
  deleteUser,
  changePassword,
  writeUsers,
};
