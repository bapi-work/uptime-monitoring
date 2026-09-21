// Shared auth/role-check middleware used by every route file.
//
// Roles: 'admin' (full access, including user management and deletes),
// 'manager' (can create/edit but not delete, no user management),
// 'user' (read-only access to the admin dashboard).
//
// Authorization is decided from the *live* user record on every request,
// not a role cached in the session at login time — otherwise deleting or
// demoting a user wouldn't take effect until their session happened to
// expire (up to 8 hours), which defeats the point of revoking access.

const users = require('./users');

function liveUser(req) {
  if (!req.session || !req.session.user || !req.session.user.id) return null;
  return users.getUserById(req.session.user.id);
}

function requireAuth(req, res, next) {
  const user = liveUser(req);
  if (!user) {
    if (req.session) req.session.destroy(() => {});
    return res.status(401).json({ error: 'Authentication required' });
  }
  next();
}

function requireRole(...roles) {
  const allowed = roles.flat();
  return (req, res, next) => {
    const user = liveUser(req);
    if (!user) {
      if (req.session) req.session.destroy(() => {});
      return res.status(401).json({ error: 'Authentication required' });
    }
    if (!allowed.includes(user.role)) {
      return res.status(403).json({ error: 'You do not have permission to perform this action' });
    }
    next();
  };
}

module.exports = { requireAuth, requireRole, liveUser };
