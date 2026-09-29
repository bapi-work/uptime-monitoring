#!/usr/bin/env node
// Recovery tool for when nobody can log in (lost admin password, lost 2FA
// device, etc). Edits data/users.json directly — no HTTP/login required.
//
// Usage:
//   node scripts/reset-admin-password.js <new-password> [username]
//
// If [username] is omitted, resets the first admin account found.
// Also disables 2FA on that account, since a lost password often means a
// lost authenticator too, and a working password with no way past 2FA is
// still a lockout.

const path = require('path');
const users = require(path.join(__dirname, '..', 'lib', 'users'));

function main() {
  const [, , newPassword, username] = process.argv;

  if (!newPassword) {
    console.error('Usage: node scripts/reset-admin-password.js <new-password> [username]');
    process.exit(1);
  }
  if (newPassword.length < 6) {
    console.error('Password must be at least 6 characters.');
    process.exit(1);
  }

  const bcrypt = require('bcryptjs');
  const all = users.getUsers(); // also runs first-run setup if data/users.json doesn't exist yet
  const target = username
    ? all.find((u) => u.username.toLowerCase() === username.toLowerCase())
    : all.find((u) => u.role === 'admin');

  if (!target) {
    console.error(username ? `No user named "${username}" found.` : 'No admin account found in data/users.json.');
    process.exit(1);
  }

  target.passwordHash = bcrypt.hashSync(newPassword, 10);
  const had2fa = !!target.twoFactorEnabled;
  target.twoFactorEnabled = false;
  target.twoFactorSecret = undefined;
  users.writeUsers(all);

  console.log(`Password reset for user "${target.username}" (role: ${target.role}).`);
  if (had2fa) console.log('Two-factor authentication was also disabled on this account so you can log back in.');
  console.log('You can now log in at /login with the new password.');
}

main();
