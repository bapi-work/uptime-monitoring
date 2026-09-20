const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = path.join(__dirname, '..', 'data');
const SECRET_FILE = path.join(DATA_DIR, 'session-secret');

// A session secret that changes on every restart would silently log out every
// admin whenever the container restarts (deploy, crash-restart, host reboot).
// If SESSION_SECRET isn't set explicitly, generate one once and persist it so
// sessions survive restarts; only an explicit env var can override it.
function getSessionSecret() {
  if (process.env.SESSION_SECRET) return process.env.SESSION_SECRET;

  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (fs.existsSync(SECRET_FILE)) {
    const existing = fs.readFileSync(SECRET_FILE, 'utf8').trim();
    if (existing) return existing;
  }

  const generated = crypto.randomBytes(48).toString('hex');
  fs.writeFileSync(SECRET_FILE, generated);
  return generated;
}

module.exports = { getSessionSecret };
