const express = require('express');
const store = require('../lib/store');
const scheduler = require('../lib/scheduler');
const { testNotification } = require('../lib/notify');
const { requireAuth, requireRole } = require('../lib/rbac');

const router = express.Router();

// Managers can create/edit; only admins can delete. Read access is any
// logged-in role (admin, manager, user).
const canWrite = requireRole('admin', 'manager');
const canDelete = requireRole('admin');

function todayStr(d = new Date()) {
  return d.toISOString().slice(0, 10);
}

function lastNDates(n) {
  const dates = [];
  const now = new Date();
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(now);
    d.setUTCDate(d.getUTCDate() - i);
    dates.push(todayStr(d));
  }
  return dates;
}

function summarizeRange(dailyStats, days) {
  const dates = lastNDates(days);
  const map = new Map(dailyStats.map((d) => [d.date, d]));
  let up = 0;
  let down = 0;
  let pingSum = 0;
  let pingCount = 0;
  const series = dates.map((date) => {
    const entry = map.get(date);
    if (!entry) return { date, uptime: null, up: 0, down: 0, avgPing: null };
    up += entry.up;
    down += entry.down;
    pingSum += entry.pingSum || 0;
    pingCount += entry.pingCount || 0;
    const total = entry.up + entry.down;
    return {
      date,
      uptime: total > 0 ? (entry.up / total) * 100 : null,
      up: entry.up,
      down: entry.down,
      avgPing: entry.pingCount > 0 ? Math.round(entry.pingSum / entry.pingCount) : null,
    };
  });
  const total = up + down;
  return {
    days,
    series,
    uptimePercent: total > 0 ? (up / total) * 100 : null,
    avgPing: pingCount > 0 ? Math.round(pingSum / pingCount) : null,
  };
}

function hourKeyStr(d) {
  return d.toISOString().slice(0, 13); // YYYY-MM-DDTHH
}

function lastNHours(n) {
  const keys = [];
  const now = new Date();
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(now.getTime() - i * 60 * 60 * 1000);
    keys.push(hourKeyStr(d));
  }
  return keys;
}

function hoursSinceMidnightUTC() {
  const now = new Date();
  const hoursElapsed = now.getUTCHours();
  const keys = [];
  for (let h = 0; h <= hoursElapsed; h++) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), h));
    keys.push(hourKeyStr(d));
  }
  return keys;
}

function summarizeHourly(hourlyStats, hourKeys) {
  const map = new Map(hourlyStats.map((h) => [h.hour, h]));
  let up = 0;
  let down = 0;
  let pingSum = 0;
  let pingCount = 0;
  const series = hourKeys.map((hour) => {
    const entry = map.get(hour);
    const date = `${hour}:00:00.000Z`;
    if (!entry) return { date, uptime: null, up: 0, down: 0, avgPing: null };
    up += entry.up;
    down += entry.down;
    pingSum += entry.pingSum || 0;
    pingCount += entry.pingCount || 0;
    const total = entry.up + entry.down;
    return {
      date,
      uptime: total > 0 ? (entry.up / total) * 100 : null,
      up: entry.up,
      down: entry.down,
      avgPing: entry.pingCount > 0 ? Math.round(entry.pingSum / entry.pingCount) : null,
    };
  });
  const total = up + down;
  return {
    series,
    uptimePercent: total > 0 ? (up / total) * 100 : null,
    avgPing: pingCount > 0 ? Math.round(pingSum / pingCount) : null,
  };
}

// ---- Monitors CRUD ----

router.get('/monitors', requireAuth, (req, res) => {
  res.json(store.getMonitors());
});

router.get('/monitors/:id', requireAuth, (req, res) => {
  const monitor = store.getMonitor(req.params.id);
  if (!monitor) return res.status(404).json({ error: 'Not found' });
  res.json(monitor);
});

function validateMonitorInput(body) {
  const { name, type, url, host, port } = body;
  if (!name) return 'name is required';
  if (type === 'tcp' && (!host || !port)) return 'host and port are required for tcp monitors';
  if (type === 'dns' && !host) return 'host is required for dns monitors';
  if (type === 'ping' && !host && !url) return 'host is required for ping monitors';
  if ((type === 'json_query') && !url) return 'url is required for json query monitors';
  if ((type === 'json_query') && !body.jsonPath) return 'jsonPath is required for json query monitors';
  if (type === 'keyword' && !url) return 'url is required for keyword monitors';
  if (type === 'keyword' && !body.keyword) return 'keyword is required for keyword monitors';
  if (type === 'websocket' && !url) return 'url is required for websocket monitors';
  if ((!type || type === 'http') && !url) return 'url is required for http monitors';
  return null;
}

router.post('/monitors', canWrite, (req, res) => {
  const error = validateMonitorInput(req.body || {});
  if (error) return res.status(400).json({ error });
  const monitor = store.createMonitor(req.body);
  scheduler.refreshMonitor(monitor.id);
  res.status(201).json(monitor);
});

router.put('/monitors/:id', canWrite, (req, res) => {
  const updated = store.updateMonitor(req.params.id, req.body || {});
  if (!updated) return res.status(404).json({ error: 'Not found' });
  scheduler.refreshMonitor(updated.id);
  res.json(updated);
});

router.delete('/monitors/:id', canDelete, (req, res) => {
  scheduler.unscheduleMonitor(req.params.id);
  store.deleteMonitor(req.params.id);
  res.status(204).end();
});

// ---- Heartbeats (admin detail view) ----

router.get('/monitors/:id/heartbeats', requireAuth, (req, res) => {
  const monitor = store.getMonitor(req.params.id);
  if (!monitor) return res.status(404).json({ error: 'Not found' });
  const limit = req.query.limit ? Number(req.query.limit) : 100;
  res.json(store.getHeartbeats(req.params.id, limit));
});

// ---- Events / incident history ----

router.get('/monitors/:id/events', requireAuth, (req, res) => {
  const monitor = store.getMonitor(req.params.id);
  if (!monitor) return res.status(404).json({ error: 'Not found' });
  const limit = req.query.limit ? Number(req.query.limit) : 50;
  res.json(store.getEvents(req.params.id, limit));
});

// ---- Tags ----

router.get('/tags', requireAuth, (req, res) => {
  const set = new Set();
  for (const m of store.getMonitors()) {
    for (const t of m.tags || []) set.add(t);
  }
  res.json([...set].sort());
});

// ---- Notification channels ----

router.get('/notifications', requireAuth, (req, res) => {
  res.json(store.getNotifications());
});

router.post('/notifications', canWrite, (req, res) => {
  const { name, type } = req.body || {};
  if (!name || !type) return res.status(400).json({ error: 'name and type are required' });
  res.status(201).json(store.createNotification(req.body));
});

router.put('/notifications/:id', canWrite, (req, res) => {
  const updated = store.updateNotification(req.params.id, req.body || {});
  if (!updated) return res.status(404).json({ error: 'Not found' });
  res.json(updated);
});

router.post('/notifications/test', requireAuth, async (req, res) => {
  const { type, config } = req.body || {};
  if (!type) return res.status(400).json({ error: 'type is required' });
  const result = await testNotification({ type, config: config || {} });
  res.json(result);
});

router.post('/notifications/:id/test', requireAuth, async (req, res) => {
  const channel = store.getNotification(req.params.id);
  if (!channel) return res.status(404).json({ error: 'Not found' });
  const result = await testNotification(channel);
  res.json(result);
});

router.delete('/notifications/:id', canDelete, (req, res) => {
  store.deleteNotification(req.params.id);
  res.status(204).end();
});

// ---- Maintenance windows ----

router.get('/maintenance', requireAuth, (req, res) => {
  res.json(store.getMaintenanceWindows());
});

router.post('/maintenance', canWrite, (req, res) => {
  const { title, monitorIds, start, end } = req.body || {};
  if (!start || !end) return res.status(400).json({ error: 'start and end are required' });
  res.status(201).json(store.createMaintenanceWindow(req.body));
});

router.delete('/maintenance/:id', canDelete, (req, res) => {
  store.deleteMaintenanceWindow(req.params.id);
  res.status(204).end();
});

// ---- Status pages (admin management) ----

router.get('/statuspages', (req, res) => {
  const { liveUser } = require('../lib/rbac');
  const user = liveUser(req);
  const pages = store.getStatusPages().map((p) => ({
    ...p,
    isPublic: p.isPublic !== false,
  }));
  if (!user) return res.json(pages.filter((p) => p.isPublic));
  res.json(pages);
});

router.post('/statuspages', canWrite, (req, res) => {
  const { title } = req.body || {};
  if (!title) return res.status(400).json({ error: 'title is required' });
  res.status(201).json(store.createStatusPage(req.body));
});

router.put('/statuspages/:id', canWrite, (req, res) => {
  const data = req.body || {};
  const updated = store.updateStatusPage(req.params.id, {
    title: data.title,
    description: data.description,
    slug: data.slug,
    monitorIds: data.monitorIds,
    tags: data.tags,
    isPublic: data.isPublic,
  });
  if (!updated) return res.status(404).json({ error: 'Not found' });
  res.json(updated);
});

router.delete('/statuspages/:id', canDelete, (req, res) => {
  store.deleteStatusPage(req.params.id);
  res.status(204).end();
});

// ---- All-monitors status listing (admin only — see the "All monitors"
// view). Public visitors only ever see specific named status pages, whose
// data comes from /status/:id and /public/statuspages/:slug below. ----

router.get('/status', requireRole('admin'), (req, res) => {
  const monitors = store.getMonitors();
  const data = monitors.map((m) => {
    const daily = store.getDailyStats(m.id);
    return {
      id: m.id,
      name: m.name,
      type: m.type,
      currentStatus: m.currentStatus,
      lastCheck: m.lastCheck,
      active: m.active,
      uptime24h: summarizeRange(daily, 1).uptimePercent,
      uptime7d: summarizeRange(daily, 7).uptimePercent,
      uptime30d: summarizeRange(daily, 30).uptimePercent,
    };
  });
  res.json(data);
});

const ALLOWED_RANGES = ['hourly', 'daily', '7', '30', '45', '90'];

router.get('/status/:id', (req, res) => {
  const monitor = store.getMonitor(req.params.id);
  if (!monitor) return res.status(404).json({ error: 'Not found' });

  let range = String(req.query.range || '');
  if (!ALLOWED_RANGES.includes(range)) {
    // backwards-compatible fallback for the old ?days= param
    const days = Number(req.query.days);
    range = [30, 45, 90].includes(days) ? String(days) : '30';
  }

  let summary;
  if (range === 'hourly') {
    summary = { range, ...summarizeHourly(store.getHourlyStats(monitor.id), lastNHours(24)) };
  } else if (range === 'daily') {
    summary = { range, ...summarizeHourly(store.getHourlyStats(monitor.id), hoursSinceMidnightUTC()) };
  } else {
    const days = Number(range);
    summary = { range, days, ...summarizeRange(store.getDailyStats(monitor.id), days) };
  }

  res.json({
    id: monitor.id,
    name: monitor.name,
    type: monitor.type,
    currentStatus: monitor.currentStatus,
    lastCheck: monitor.lastCheck,
    tags: monitor.tags || [],
    certExpiryDate: monitor.certExpiryDate,
    certDaysRemaining: monitor.certDaysRemaining,
    events: store.getEvents(monitor.id, 20),
    ...summary,
  });
});

// ---- Public status pages (multiple, by slug) ----

router.get('/public/statuspages', (req, res) => {
  res.json(store.getStatusPages().map((p) => ({ slug: p.slug, title: p.title })));
});

router.get('/public/statuspages/:slug', (req, res) => {
  const page = store.getStatusPage(req.params.slug);
  if (!page) return res.status(404).json({ error: 'Not found' });
  const monitors = store.getMonitors().filter((m) => page.monitorIds.includes(m.id));
  res.json({
    id: page.id,
    slug: page.slug,
    title: page.title,
    description: page.description,
    monitorIds: page.monitorIds,
    monitors: monitors.map((m) => ({ id: m.id, name: m.name })),
  });
});

// ---- Branding (public read so status/login pages can apply it, admin write) ----

router.get('/branding', (req, res) => {
  res.json(store.getBranding());
});

router.put('/branding', canWrite, (req, res) => {
  res.json(store.updateBranding(req.body || {}));
});

module.exports = router;
