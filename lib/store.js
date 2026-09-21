const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const MONITORS_FILE = path.join(DATA_DIR, 'monitors.json');
const HEARTBEATS_DIR = path.join(DATA_DIR, 'heartbeats');
const DAILY_DIR = path.join(DATA_DIR, 'dailystats');
const HOURLY_DIR = path.join(DATA_DIR, 'hourlystats');
const EVENTS_DIR = path.join(DATA_DIR, 'events');
const NOTIFICATIONS_FILE = path.join(DATA_DIR, 'notifications.json');
const STATUSPAGES_FILE = path.join(DATA_DIR, 'statuspages.json');
const MAINTENANCE_FILE = path.join(DATA_DIR, 'maintenance.json');
const BRANDING_FILE = path.join(DATA_DIR, 'branding.json');

const DEFAULT_BRANDING = {
  siteName: 'Uptime Monitor',
  logoUrl: '',
  faviconUrl: '',
  accentColor: '#4f8cff',
  footerText: '',
  showPoweredBy: true,
};

function envInt(name, fallback, min) {
  const n = Number(process.env[name]);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.max(min || 1, Math.floor(n));
}

// All four are overridable via env vars so storage growth can be tuned per
// deployment without code changes. Minimums are enforced so the Hourly/Daily
// status page ranges and retry logic never silently break.
const MAX_RAW_HEARTBEATS = envInt('RETENTION_HEARTBEATS', 500, 20); // per monitor, kept for recent response-time charts
const MAX_DAILY_DAYS = envInt('RETENTION_DAILY_DAYS', 90, 7); // status page's longest range option is 90 days
const MAX_HOURLY_HOURS = envInt('RETENTION_HOURLY_HOURS', 50, 25); // must cover a rolling 24h window plus "today since midnight" near a day boundary
const MAX_EVENTS = envInt('RETENTION_EVENTS', 200, 10); // per monitor, kept for the incident/event history log
const MAX_MAINTENANCE_AGE_DAYS = envInt('RETENTION_MAINTENANCE_DAYS', 30, 1); // how long a finished maintenance window stays listed

function ensureDirs() {
  for (const d of [DATA_DIR, HEARTBEATS_DIR, DAILY_DIR, HOURLY_DIR, EVENTS_DIR]) {
    if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
  }
  if (!fs.existsSync(MONITORS_FILE)) writeJSON(MONITORS_FILE, []);
  if (!fs.existsSync(NOTIFICATIONS_FILE)) writeJSON(NOTIFICATIONS_FILE, []);
  if (!fs.existsSync(STATUSPAGES_FILE)) writeJSON(STATUSPAGES_FILE, []);
  if (!fs.existsSync(MAINTENANCE_FILE)) writeJSON(MAINTENANCE_FILE, []);
  if (!fs.existsSync(BRANDING_FILE)) writeJSON(BRANDING_FILE, DEFAULT_BRANDING);
}

// Retroactively applies the current retention limits to data already on
// disk — so lowering a RETENTION_* env var and restarting actually shrinks
// storage, not just caps future growth — and drops maintenance windows that
// finished long ago. Safe to call on every boot; a no-op once everything is
// already within limits.
function applyRetentionLimits() {
  ensureDirs();
  for (const m of getMonitors()) {
    trimFileToLength(heartbeatsFile(m.id), MAX_RAW_HEARTBEATS);
    trimFileToLength(dailyFile(m.id), MAX_DAILY_DAYS);
    trimFileToLength(hourlyFile(m.id), MAX_HOURLY_HOURS);
    trimFileToLength(eventsFile(m.id), MAX_EVENTS);
  }

  const cutoff = Date.now() - MAX_MAINTENANCE_AGE_DAYS * 24 * 60 * 60 * 1000;
  const windows = getMaintenanceWindows();
  const kept = windows.filter((w) => new Date(w.end).getTime() >= cutoff);
  if (kept.length !== windows.length) writeJSON(MAINTENANCE_FILE, kept);
}

function trimFileToLength(file, max) {
  const list = readJSON(file, null);
  if (!Array.isArray(list) || list.length <= max) return;
  writeJSON(file, list.slice(list.length - max));
}

function readJSON(file, fallback) {
  try {
    const raw = fs.readFileSync(file, 'utf8');
    return JSON.parse(raw);
  } catch (e) {
    return fallback;
  }
}

function writeJSON(file, data) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}

function newId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

// ---- Monitors ----

function getMonitors() {
  ensureDirs();
  return readJSON(MONITORS_FILE, []);
}

function getMonitor(id) {
  return getMonitors().find((m) => m.id === id) || null;
}

function saveMonitors(monitors) {
  writeJSON(MONITORS_FILE, monitors);
}

function createMonitor(data) {
  const monitors = getMonitors();
  const id = newId();
  const monitor = {
    id,
    name: data.name,
    // 'http' | 'tcp' | 'keyword' | 'json_query' | 'dns' | 'ping' | 'websocket'
    type: data.type || 'http',
    url: data.url || '',
    host: data.host || '',
    port: data.port ? Number(data.port) : undefined,
    interval: Number(data.interval) || 60, // seconds
    timeout: Number(data.timeout) || 10, // seconds
    retries: Number(data.retries) || 0,
    expectedStatus: data.expectedStatus || '2xx',
    // keyword monitor
    keyword: data.keyword || '',
    keywordType: data.keywordType || 'contains', // 'contains' | 'not_contains'
    // json_query monitor
    jsonPath: data.jsonPath || '',
    jsonExpected: data.jsonExpected || '',
    // dns monitor
    dnsRecordType: data.dnsRecordType || 'A',
    dnsExpected: data.dnsExpected || '',
    // certificate expiry (http/https monitors)
    certCheck: !!data.certCheck,
    certExpiryThreshold: data.certExpiryThreshold ? Number(data.certExpiryThreshold) : 14,
    tags: Array.isArray(data.tags) ? data.tags : [],
    notificationIds: Array.isArray(data.notificationIds) ? data.notificationIds : [],
    active: data.active !== false,
    createdAt: new Date().toISOString(),
    currentStatus: 'pending', // 'up' | 'down' | 'pending' | 'maintenance'
    lastCheck: null,
    certExpiryDate: null,
    certDaysRemaining: null,
  };
  monitors.push(monitor);
  saveMonitors(monitors);
  writeJSON(heartbeatsFile(id), []);
  writeJSON(dailyFile(id), []);
  writeJSON(hourlyFile(id), []);
  writeJSON(eventsFile(id), []);
  return monitor;
}

const EDITABLE_FIELDS = [
  'name', 'type', 'url', 'host', 'interval', 'timeout', 'retries', 'expectedStatus',
  'keyword', 'keywordType', 'jsonPath', 'jsonExpected', 'dnsRecordType', 'dnsExpected',
  'certCheck', 'certExpiryThreshold', 'tags', 'notificationIds',
];

function updateMonitor(id, data) {
  const monitors = getMonitors();
  const idx = monitors.findIndex((m) => m.id === id);
  if (idx === -1) return null;
  const m = monitors[idx];
  const updated = { ...m };
  for (const key of EDITABLE_FIELDS) {
    if (data[key] === undefined) continue;
    if (key === 'interval' || key === 'timeout' || key === 'retries' || key === 'certExpiryThreshold') {
      updated[key] = Number(data[key]);
    } else if (key === 'certCheck') {
      updated[key] = !!data[key];
    } else {
      updated[key] = data[key];
    }
  }
  if (data.port !== undefined) updated.port = Number(data.port);
  if (data.active !== undefined) updated.active = !!data.active;
  monitors[idx] = updated;
  saveMonitors(monitors);
  return updated;
}

function deleteMonitor(id) {
  const monitors = getMonitors().filter((m) => m.id !== id);
  saveMonitors(monitors);
  for (const f of [heartbeatsFile(id), dailyFile(id), hourlyFile(id), eventsFile(id)]) {
    if (fs.existsSync(f)) fs.unlinkSync(f);
  }
  // remove from any status pages
  const pages = getStatusPages().map((p) => ({
    ...p,
    monitorIds: p.monitorIds.filter((mid) => mid !== id),
  }));
  saveStatusPages(pages);
}

function setMonitorStatus(id, status, lastCheck, extra) {
  const monitors = getMonitors();
  const idx = monitors.findIndex((m) => m.id === id);
  if (idx === -1) return;
  monitors[idx].currentStatus = status;
  monitors[idx].lastCheck = lastCheck;
  if (extra && extra.certExpiryDate !== undefined) monitors[idx].certExpiryDate = extra.certExpiryDate;
  if (extra && extra.certDaysRemaining !== undefined) monitors[idx].certDaysRemaining = extra.certDaysRemaining;
  saveMonitors(monitors);
}

// ---- Heartbeats (raw, recent) ----

function heartbeatsFile(id) {
  return path.join(HEARTBEATS_DIR, `${id}.json`);
}

function getHeartbeats(id, limit) {
  const all = readJSON(heartbeatsFile(id), []);
  if (limit) return all.slice(-limit);
  return all;
}

function addHeartbeat(id, hb) {
  const file = heartbeatsFile(id);
  const list = readJSON(file, []);
  list.push(hb);
  while (list.length > MAX_RAW_HEARTBEATS) list.shift();
  writeJSON(file, list);
}

// ---- Daily aggregate stats (for status page ranges) ----

function dailyFile(id) {
  return path.join(DAILY_DIR, `${id}.json`);
}

function getDailyStats(id) {
  return readJSON(dailyFile(id), []);
}

function recordDailyResult(id, dateStr, isUp, pingMs) {
  const file = dailyFile(id);
  const list = readJSON(file, []);
  let entry = list.find((d) => d.date === dateStr);
  if (!entry) {
    entry = { date: dateStr, up: 0, down: 0, pingSum: 0, pingCount: 0 };
    list.push(entry);
  }
  if (isUp) {
    entry.up += 1;
    if (typeof pingMs === 'number') {
      entry.pingSum += pingMs;
      entry.pingCount += 1;
    }
  } else {
    entry.down += 1;
  }
  list.sort((a, b) => (a.date < b.date ? -1 : 1));
  while (list.length > MAX_DAILY_DAYS) list.shift();
  writeJSON(file, list);
}

// ---- Hourly aggregate stats (for the Hourly / Daily status page ranges) ----

function hourlyFile(id) {
  return path.join(HOURLY_DIR, `${id}.json`);
}

function getHourlyStats(id) {
  return readJSON(hourlyFile(id), []);
}

function recordHourlyResult(id, hourKey, isUp, pingMs) {
  const file = hourlyFile(id);
  const list = readJSON(file, []);
  let entry = list.find((h) => h.hour === hourKey);
  if (!entry) {
    entry = { hour: hourKey, up: 0, down: 0, pingSum: 0, pingCount: 0 };
    list.push(entry);
  }
  if (isUp) {
    entry.up += 1;
    if (typeof pingMs === 'number') {
      entry.pingSum += pingMs;
      entry.pingCount += 1;
    }
  } else {
    entry.down += 1;
  }
  list.sort((a, b) => (a.hour < b.hour ? -1 : 1));
  while (list.length > MAX_HOURLY_HOURS) list.shift();
  writeJSON(file, list);
}

// ---- Events (status transitions / incident history) ----

function eventsFile(id) {
  return path.join(EVENTS_DIR, `${id}.json`);
}

function getEvents(id, limit) {
  const all = readJSON(eventsFile(id), []);
  if (limit) return all.slice(-limit);
  return all;
}

function addEvent(id, event) {
  const file = eventsFile(id);
  const list = readJSON(file, []);
  list.push(event);
  while (list.length > MAX_EVENTS) list.shift();
  writeJSON(file, list);
}

// ---- Notification channels ----

function getNotifications() {
  ensureDirs();
  return readJSON(NOTIFICATIONS_FILE, []);
}

function getNotification(id) {
  return getNotifications().find((n) => n.id === id) || null;
}

function createNotification(data) {
  const list = getNotifications();
  const notification = {
    id: newId(),
    name: data.name,
    type: data.type, // 'webhook' | 'slack' | 'discord' | 'telegram' | 'email'
    config: data.config || {},
    createdAt: new Date().toISOString(),
  };
  list.push(notification);
  writeJSON(NOTIFICATIONS_FILE, list);
  return notification;
}

function updateNotification(id, data) {
  const list = getNotifications();
  const idx = list.findIndex((n) => n.id === id);
  if (idx === -1) return null;
  list[idx] = {
    ...list[idx],
    name: data.name ?? list[idx].name,
    type: data.type ?? list[idx].type,
    config: data.config ?? list[idx].config,
  };
  writeJSON(NOTIFICATIONS_FILE, list);
  return list[idx];
}

function deleteNotification(id) {
  const list = getNotifications().filter((n) => n.id !== id);
  writeJSON(NOTIFICATIONS_FILE, list);
  // detach from monitors referencing it
  const monitors = getMonitors().map((m) => ({
    ...m,
    notificationIds: (m.notificationIds || []).filter((nid) => nid !== id),
  }));
  saveMonitors(monitors);
}

// ---- Status pages ----

function getStatusPages() {
  ensureDirs();
  return readJSON(STATUSPAGES_FILE, []);
}

function saveStatusPages(pages) {
  writeJSON(STATUSPAGES_FILE, pages);
}

function getStatusPage(idOrSlug) {
  return getStatusPages().find((p) => p.id === idOrSlug || p.slug === idOrSlug) || null;
}

function slugify(str) {
  return String(str || '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || newId();
}

function createStatusPage(data) {
  const pages = getStatusPages().map((p) => {
    if (!('isPublic' in p)) p.isPublic = true;
    return p;
  });
  let slug = slugify(data.slug || data.title);
  let suffix = 1;
  const base = slug;
  while (pages.some((p) => p.slug === slug)) {
    slug = `${base}-${++suffix}`;
  }
  const page = {
    id: newId(),
    slug,
    title: data.title || 'Status',
    description: data.description || '',
    monitorIds: Array.isArray(data.monitorIds) ? data.monitorIds : [],
    tags: Array.isArray(data.tags) ? data.tags : [],
    isPublic: data.isPublic !== false,
    createdAt: new Date().toISOString(),
  };
  pages.push(page);
  saveStatusPages(pages);
  return page;
}

function updateStatusPage(id, data) {
  const pages = getStatusPages();
  const idx = pages.findIndex((p) => p.id === id);
  if (idx === -1) return null;
  const page = pages[idx];
  let slug = page.slug;
  if (data.slug && data.slug !== page.slug) {
    slug = slugify(data.slug);
    if (pages.some((p) => p.id !== id && p.slug === slug)) {
      slug = `${slug}-${newId().slice(0, 4)}`;
    }
  }
  pages[idx] = {
    ...page,
    slug,
    title: data.title ?? page.title,
    description: data.description ?? page.description,
    monitorIds: data.monitorIds ?? page.monitorIds,
    tags: data.tags ?? page.tags,
    isPublic: data.isPublic !== false ? true : false,
  };
  saveStatusPages(pages);
  return pages[idx];
}

function deleteStatusPage(id) {
  saveStatusPages(getStatusPages().filter((p) => p.id !== id));
}

// ---- Maintenance windows ----

function getMaintenanceWindows() {
  ensureDirs();
  return readJSON(MAINTENANCE_FILE, []);
}

function createMaintenanceWindow(data) {
  const list = getMaintenanceWindows();
  const win = {
    id: newId(),
    title: data.title || 'Maintenance',
    monitorIds: Array.isArray(data.monitorIds) ? data.monitorIds : [],
    start: data.start,
    end: data.end,
    createdAt: new Date().toISOString(),
  };
  list.push(win);
  writeJSON(MAINTENANCE_FILE, list);
  return win;
}

function deleteMaintenanceWindow(id) {
  writeJSON(MAINTENANCE_FILE, getMaintenanceWindows().filter((w) => w.id !== id));
}

function isUnderMaintenance(monitorId, at = new Date()) {
  const now = at.getTime();
  return getMaintenanceWindows().some((w) => {
    if (!w.monitorIds.includes(monitorId)) return false;
    const start = new Date(w.start).getTime();
    const end = new Date(w.end).getTime();
    return now >= start && now <= end;
  });
}

// ---- Branding ----

function getBranding() {
  ensureDirs();
  return { ...DEFAULT_BRANDING, ...readJSON(BRANDING_FILE, {}) };
}

function updateBranding(data) {
  const current = getBranding();
  const updated = {
    siteName: data.siteName !== undefined ? String(data.siteName).slice(0, 100) : current.siteName,
    logoUrl: data.logoUrl !== undefined ? String(data.logoUrl).slice(0, 2_000_000) : current.logoUrl,
    faviconUrl: data.faviconUrl !== undefined ? String(data.faviconUrl).slice(0, 2_000_000) : current.faviconUrl,
    accentColor: data.accentColor !== undefined ? String(data.accentColor).slice(0, 20) : current.accentColor,
    footerText: data.footerText !== undefined ? String(data.footerText).slice(0, 500) : current.footerText,
    showPoweredBy: data.showPoweredBy !== undefined ? !!data.showPoweredBy : current.showPoweredBy,
  };
  writeJSON(BRANDING_FILE, updated);
  return updated;
}

module.exports = {
  ensureDirs,
  applyRetentionLimits,
  getBranding,
  updateBranding,
  getMonitors,
  getMonitor,
  createMonitor,
  updateMonitor,
  deleteMonitor,
  setMonitorStatus,
  getHeartbeats,
  addHeartbeat,
  getDailyStats,
  recordDailyResult,
  getHourlyStats,
  recordHourlyResult,
  getEvents,
  addEvent,
  getNotifications,
  getNotification,
  createNotification,
  updateNotification,
  deleteNotification,
  getStatusPages,
  getStatusPage,
  createStatusPage,
  updateStatusPage,
  deleteStatusPage,
  getMaintenanceWindows,
  createMaintenanceWindow,
  deleteMaintenanceWindow,
  isUnderMaintenance,
};
