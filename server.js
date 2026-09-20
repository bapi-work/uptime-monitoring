const path = require('path');
const express = require('express');
const session = require('express-session');
const FileStore = require('session-file-store')(session);
const store = require('./lib/store');
const users = require('./lib/users');
const scheduler = require('./lib/scheduler');
const realtime = require('./lib/realtime');
const { getSessionSecret } = require('./lib/secret');
const { rateLimit } = require('./lib/rateLimit');
const apiRouter = require('./routes/api');
const authRouter = require('./routes/auth');

const app = express();
const PORT = process.env.PORT || 3300;

store.ensureDirs();
users.ensureAdmin();

// Set TRUST_PROXY=1 when running behind a reverse proxy (nginx, Caddy, a
// cloud load balancer) so req.ip and secure cookies work correctly.
if (process.env.TRUST_PROXY === '1') {
  app.set('trust proxy', 1);
}

// Baseline security headers. Deliberately minimal (no extra dependency) —
// this is not a general-purpose hardening framework, just the handful of
// headers relevant to this app.
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  next();
});

app.use(express.json({ limit: '5mb' })); // logos/favicons are uploaded as base64 data URLs
app.use(
  session({
    store: new FileStore({
      path: path.join(__dirname, 'data', 'sessions'),
      ttl: 60 * 60 * 8, // seconds, matches cookie maxAge below
      logFn: () => {}, // quiet by default; errors still throw where it matters
    }),
    secret: getSessionSecret(),
    resave: false,
    saveUninitialized: false,
    cookie: {
      maxAge: 1000 * 60 * 60 * 8, // 8 hours
      httpOnly: true,
      sameSite: 'lax',
      // Set COOKIE_SECURE=1 once TLS is terminated in front of the app
      // (directly or via a reverse proxy with TRUST_PROXY=1).
      secure: process.env.COOKIE_SECURE === '1',
    },
  })
);

// Throttle login attempts to blunt password brute-forcing.
app.use('/api/login', rateLimit({ windowMs: 15 * 60 * 1000, max: 20, message: 'Too many login attempts. Try again later.' }));

app.get('/healthz', (req, res) => res.status(200).json({ ok: true }));

app.use('/api', apiRouter);
app.use('/api', authRouter);

function requireAdminPage(req, res, next) {
  if (req.session && req.session.user) return next();
  res.redirect('/login.html');
}

// Admin dashboard is gated behind login; public status page(s) and static
// assets (css/js) remain open so anyone can view system status.
app.get('/', requireAdminPage, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});
app.get('/index.html', requireAdminPage, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Named status pages: /status/<slug> reuses the same status page shell,
// which reads the slug from the URL client-side.
app.get('/status/:slug', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'status.html'));
});

app.use(express.static(path.join(__dirname, 'public')));

// Last-resort safety net: log and keep running rather than crash the whole
// monitoring process over an unexpected error in a background check/notify path.
process.on('uncaughtException', (err) => {
  console.error('Uncaught exception:', err);
});
process.on('unhandledRejection', (err) => {
  console.error('Unhandled rejection:', err);
});

const server = app.listen(PORT, () => {
  console.log(`Uptime monitor running at http://localhost:${PORT}`);
  console.log(`Admin login:      http://localhost:${PORT}/login.html`);
  console.log(`Public status page: http://localhost:${PORT}/status.html`);
  scheduler.startAll();
});

realtime.init(server);

function shutdown(signal) {
  console.log(`${signal} received, shutting down`);
  server.close(() => process.exit(0));
  // Force-exit if connections don't drain in time.
  setTimeout(() => process.exit(0), 5000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
