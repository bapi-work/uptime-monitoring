const express = require('express');
const users = require('../lib/users');
const twofa = require('../lib/twofa');

const router = express.Router();

function requireAuth(req, res, next) {
  if (req.session && req.session.user) return next();
  res.status(401).json({ error: 'Authentication required' });
}

router.post('/login', async (req, res) => {
  const { username, password, token } = req.body || {};
  if (!users.verifyLogin(username, password)) {
    return res.status(401).json({ error: 'Invalid username or password' });
  }
  if (twofa.isEnabled()) {
    if (!token) {
      return res.status(200).json({ ok: false, requiresTwoFactor: true });
    }
    if (!(await twofa.verifyToken(token))) {
      return res.status(401).json({ error: 'Invalid 2FA code' });
    }
  }
  req.session.user = { username };
  res.json({ ok: true, username });
});

router.post('/logout', (req, res) => {
  req.session.destroy(() => {
    res.json({ ok: true });
  });
});

router.get('/session', (req, res) => {
  if (req.session && req.session.user) {
    return res.json({ authenticated: true, username: req.session.user.username, twoFactorEnabled: twofa.isEnabled() });
  }
  res.json({ authenticated: false });
});

router.post('/change-password', requireAuth, (req, res) => {
  const { currentPassword, newPassword } = req.body || {};
  const result = users.changePassword(currentPassword, newPassword);
  if (!result.ok) return res.status(400).json({ error: result.error });
  res.json({ ok: true });
});

// ---- Two-factor authentication (TOTP) ----

router.post('/2fa/setup', requireAuth, async (req, res) => {
  const { secret, qrDataUrl } = await twofa.generateSetupQrCode(req.session.user.username);
  res.json({ secret, qrDataUrl });
});

router.post('/2fa/confirm', requireAuth, async (req, res) => {
  const result = await twofa.confirmSetup(req.body && req.body.token);
  if (!result.ok) return res.status(400).json({ error: result.error });
  res.json({ ok: true });
});

router.post('/2fa/disable', requireAuth, (req, res) => {
  twofa.disable();
  res.json({ ok: true });
});

module.exports = router;
