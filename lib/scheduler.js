const store = require('./store');
const { runCheck, getCertInfo } = require('./checker');
const { notifyAll } = require('./notify');
const realtime = require('./realtime');

const timers = new Map(); // monitorId -> interval handle
const failCounts = new Map(); // monitorId -> consecutive failure count

function todayStr(d = new Date()) {
  return d.toISOString().slice(0, 10); // YYYY-MM-DD (UTC)
}

function hourKey(d = new Date()) {
  return d.toISOString().slice(0, 13); // YYYY-MM-DDTHH (UTC)
}

async function performCheck(monitor) {
  if (store.isUnderMaintenance(monitor.id)) {
    const now = new Date().toISOString();
    store.setMonitorStatus(monitor.id, 'maintenance', now);
    realtime.broadcast('monitor-update', { id: monitor.id, status: 'maintenance', lastCheck: now });
    return;
  }

  const result = await runCheck(monitor);
  const retries = monitor.retries || 0;
  let finalStatus = result.status;

  if (result.status === 'down' && retries > 0) {
    const fails = (failCounts.get(monitor.id) || 0) + 1;
    failCounts.set(monitor.id, fails);
    if (fails <= retries) {
      finalStatus = 'up-pending-retry';
    } else {
      failCounts.set(monitor.id, 0);
    }
  } else {
    failCounts.set(monitor.id, 0);
  }

  if (finalStatus === 'up-pending-retry') return;

  const now = new Date().toISOString();
  const previousStatus = monitor.currentStatus;

  store.addHeartbeat(monitor.id, { time: now, status: finalStatus, ping: result.ping, message: result.message });
  store.recordDailyResult(monitor.id, todayStr(), finalStatus === 'up', result.ping);
  store.recordHourlyResult(monitor.id, hourKey(), finalStatus === 'up', result.ping);

  let certExtra = {};
  if (monitor.certCheck && (monitor.type === 'http' || monitor.type === 'keyword' || monitor.type === 'json_query')) {
    const certInfo = await getCertInfo(monitor).catch(() => null);
    if (certInfo) {
      certExtra = { certExpiryDate: certInfo.validTo, certDaysRemaining: certInfo.daysRemaining };
      if (certInfo.daysRemaining <= monitor.certExpiryThreshold && finalStatus === 'up') {
        finalStatus = 'down';
        result.message = `Certificate expires in ${certInfo.daysRemaining} day(s)`;
      }
    }
  }

  store.setMonitorStatus(monitor.id, finalStatus, now, certExtra);
  realtime.broadcast('monitor-update', { id: monitor.id, status: finalStatus, lastCheck: now, ping: result.ping, ...certExtra });

  const isTransition = previousStatus !== finalStatus && (previousStatus === 'up' || previousStatus === 'down') && (finalStatus === 'up' || finalStatus === 'down');
  if (isTransition || previousStatus === 'pending') {
    store.addEvent(monitor.id, { time: now, status: finalStatus, message: result.message });
    if (isTransition && monitor.notificationIds && monitor.notificationIds.length) {
      const channels = monitor.notificationIds.map((id) => store.getNotification(id)).filter(Boolean);
      notifyAll(channels, monitor, finalStatus, result.message).catch(() => {});
    }
  }
}

function scheduleMonitor(monitor) {
  unscheduleMonitor(monitor.id);
  if (!monitor.active) return;
  const intervalMs = Math.max(5, monitor.interval || 60) * 1000;

  performCheck(monitor).catch(() => {});
  const handle = setInterval(() => {
    const fresh = store.getMonitor(monitor.id);
    if (!fresh || !fresh.active) {
      unscheduleMonitor(monitor.id);
      return;
    }
    performCheck(fresh).catch(() => {});
  }, intervalMs);

  timers.set(monitor.id, handle);
}

function unscheduleMonitor(id) {
  const handle = timers.get(id);
  if (handle) {
    clearInterval(handle);
    timers.delete(id);
  }
}

function startAll() {
  store.ensureDirs();
  const monitors = store.getMonitors();
  for (const m of monitors) scheduleMonitor(m);
}

function refreshMonitor(id) {
  const monitor = store.getMonitor(id);
  if (monitor) scheduleMonitor(monitor);
  else unscheduleMonitor(id);
}

module.exports = { startAll, scheduleMonitor, unscheduleMonitor, refreshMonitor };
