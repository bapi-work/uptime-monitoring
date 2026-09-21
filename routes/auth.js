const express = require('express');
const users = require('../lib/users');
const twofa = require('../lib/twofa');
const { requireAuth, requireRole, liveUser } = require('../lib/rbac');

const router = express.Router();

router.post('/login', async (req, res) => {
  const { username, password, token, redirect } = req.body || {};
  const user = users.verifyLogin(username, password);
  if (!user) {
    return res.status(401).json({ error: 'Invalid username or password' });
  }
  if (twofa.isEnabled(user.id)) {
    if (!token) {
      return res.status(200).json({ ok: false, requiresTwoFactor: true });
    }
    if (!(await twofa.verifyToken(user.id, token))) {
      return res.status(401).json({ error: 'Invalid 2FA code' });
    }
  }
  req.session.user = { id: user.id, username: user.username, role: user.role };
  res.json({ ok: true, username: user.username, role: user.role, redirect: redirect || '/admin' });
});

router.post('/logout', (req, res) => {
  req.session.destroy(() => {
    res.json({ ok: true });
  });
});

router.get('/session', (req, res) => {
  const user = liveUser(req);
  if (!user) return res.json({ authenticated: false });
  res.json({ authenticated: true, id: user.id, username: user.username, role: user.role, twoFactorEnabled: twofa.isEnabled(user.id) });
});

router.post('/change-password', requireAuth, (req, res) => {
  const { currentPassword, newPassword } = req.body || {};
  const result = users.changePassword(req.session.user.id, currentPassword, newPassword);
  if (!result.ok) return res.status(400).json({ error: result.error });
  res.json({ ok: true });
});

// ---- Two-factor authentication (TOTP), for the logged-in user's own account ----

router.post('/2fa/setup', requireAuth, async (req, res) => {
  const { secret, qrDataUrl } = await twofa.generateSetupQrCode(req.session.user.id, req.session.user.username);
  res.json({ secret, qrDataUrl });
});

router.post('/2fa/confirm', requireAuth, async (req, res) => {
  const result = await twofa.confirmSetup(req.session.user.id, req.body && req.body.token);
  if (!result.ok) return res.status(400).json({ error: result.error });
  res.json({ ok: true });
});

router.post('/2fa/disable', requireAuth, (req, res) => {
  twofa.disable(req.session.user.id);
  res.json({ ok: true });
});

// ---- User management (admin only) ----

router.get('/users', requireRole('admin'), (req, res) => {
  res.json(users.listUsers());
});

router.post('/users', requireRole('admin'), (req, res) => {
  const { username, password, role } = req.body || {};
  const result = users.createUser({ username, password, role });
  if (!result.ok) return res.status(400).json({ error: result.error });
  res.status(201).json(result.user);
});

router.put('/users/:id/role', requireRole('admin'), (req, res) => {
  const result = users.updateUserRole(req.params.id, req.body && req.body.role);
  if (!result.ok) return res.status(400).json({ error: result.error });
  res.json({ ok: true });
});

router.post('/users/:id/reset-password', requireRole('admin'), (req, res) => {
  const result = users.adminResetPassword(req.params.id, req.body && req.body.newPassword);
  if (!result.ok) return res.status(400).json({ error: result.error });
  res.json({ ok: true });
});

router.delete('/users/:id', requireRole('admin'), (req, res) => {
  const result = users.deleteUser(req.params.id, req.session.user.id);
  if (!result.ok) return res.status(400).json({ error: result.error });
  res.status(204).end();
});

module.exports = router;
