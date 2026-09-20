let currentRange = '30';
let monitorsCache = [];
let allowedMonitorIds = null; // null = show all monitors (default page)

const RANGE_LABELS = {
  hourly: 'last 24h',
  daily: 'today',
  '7': '7d',
  '30': '30d',
  '45': '45d',
  '90': '90d',
};

const pathMatch = window.location.pathname.match(/^\/status\/([^/]+)/);
const slug = pathMatch ? decodeURIComponent(pathMatch[1]) : null;

const rangeToggle = document.getElementById('range-toggle');
rangeToggle.addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-range]');
  if (!btn) return;
  currentRange = btn.dataset.range;
  [...rangeToggle.querySelectorAll('button')].forEach((b) => b.classList.toggle('active', b === btn));
  renderMonitors();
});

function escapeHtml(str) {
  return String(str || '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function statusBadge(status) {
  const label = { up: 'Operational', down: 'Down', pending: 'Pending', 'up-pending-retry': 'Pending', maintenance: 'Maintenance' }[status] || 'Unknown';
  return `<span class="badge ${status}"><span class="dot"></span>${label}</span>`;
}

function fmtPct(v) {
  return v === null || v === undefined ? '-' : `${v.toFixed(2)}%`;
}

function formatBarLabel(dateStr) {
  // Hour buckets are full ISO timestamps (contain "T" and a time); day buckets are plain YYYY-MM-DD.
  if (dateStr.includes('T')) {
    return new Date(dateStr).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric' });
  }
  return dateStr;
}

function renderBars(series) {
  return series
    .map((d) => {
      let cls = '';
      if (d.uptime === null) cls = '';
      else if (d.uptime >= 99.999) cls = 'up';
      else if (d.uptime <= 0.001) cls = 'down';
      else cls = 'partial';
      const label = formatBarLabel(d.date);
      const tip = d.uptime === null ? `${label}: no data` : `${label}: ${d.uptime.toFixed(1)}% up`;
      return `<div class="bar ${cls}" data-tip="${escapeHtml(tip)}"></div>`;
    })
    .join('');
}

async function renderMonitors() {
  const list = document.getElementById('monitors-list');
  const monitors = allowedMonitorIds ? monitorsCache.filter((m) => allowedMonitorIds.includes(m.id)) : monitorsCache;
  if (!monitors.length) {
    list.innerHTML = '<div class="panel empty">No monitors configured yet.</div>';
    return;
  }

  const details = await Promise.all(
    monitors.map((m) => fetch(`/api/status/${m.id}?range=${currentRange}`).then((r) => r.json()))
  );

  list.innerHTML = details
    .map((d) => {
      const tags = (d.tags || []).map((t) => `<span class="tag-pill">${escapeHtml(t)}</span>`).join('');
      const cert = d.certDaysRemaining !== null && d.certDaysRemaining !== undefined
        ? `<div>TLS cert: <b>${d.certDaysRemaining} day(s) left</b></div>`
        : '';
      const rangeLabel = RANGE_LABELS[d.range] || RANGE_LABELS[currentRange] || '';
      return `
        <div class="monitor-card" data-id="${d.id}">
          <div class="head">
            <h3>${escapeHtml(d.name)} ${tags}</h3>
            <span class="status-slot">${statusBadge(d.currentStatus)}</span>
          </div>
          <div class="stats">
            <div>Uptime (${rangeLabel}): <b>${fmtPct(d.uptimePercent)}</b></div>
            <div>Avg response: <b>${d.avgPing !== null ? d.avgPing + ' ms' : '-'}</b></div>
            <div>Last check: <b>${d.lastCheck ? new Date(d.lastCheck).toLocaleString() : '-'}</b></div>
            ${cert}
          </div>
          <div class="bars">${renderBars(d.series)}</div>
        </div>`;
    })
    .join('');
}

function renderBanner() {
  const banner = document.getElementById('overall-banner');
  const monitors = allowedMonitorIds ? monitorsCache.filter((m) => allowedMonitorIds.includes(m.id)) : monitorsCache;
  if (!monitors.length) {
    banner.innerHTML = '';
    return;
  }
  const allUp = monitors.every((m) => m.currentStatus === 'up' || m.currentStatus === 'maintenance');
  banner.innerHTML = `<div class="overall-banner ${allUp ? 'up' : 'down'}">
    ${allUp ? 'All systems operational' : 'Some systems are experiencing issues'}
  </div>`;
}

async function loadPageNav() {
  const res = await fetch('/api/public/statuspages');
  const pages = await res.json();
  const nav = document.getElementById('page-nav');
  if (!pages.length) return;
  const links = [`<a href="/status.html" class="${!slug ? '' : 'muted'}">All monitors</a>`]
    .concat(pages.map((p) => `<a href="/status/${p.slug}" class="${slug === p.slug ? '' : 'muted'}">${escapeHtml(p.title)}</a>`));
  nav.innerHTML = links.join(' &nbsp;|&nbsp; ');
  nav.style.display = '';
}

async function load() {
  if (slug) {
    const res = await fetch(`/api/public/statuspages/${encodeURIComponent(slug)}`);
    if (res.ok) {
      const page = await res.json();
      allowedMonitorIds = page.monitorIds;
      document.getElementById('page-title').textContent = page.title;
      document.title = page.title;
      if (page.description) {
        document.getElementById('page-description').textContent = page.description;
        document.getElementById('page-description').style.display = '';
      }
    }
  }
  const res = await fetch('/api/status');
  monitorsCache = await res.json();
  renderBanner();
  await renderMonitors();
}

function connectWebSocket() {
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const ws = new WebSocket(`${proto}//${window.location.host}/ws`);
  ws.onmessage = (evt) => {
    try {
      const { type, payload } = JSON.parse(evt.data);
      if (type === 'monitor-update') {
        const m = monitorsCache.find((x) => x.id === payload.id);
        if (m) {
          m.currentStatus = payload.status;
          m.lastCheck = payload.lastCheck;
          renderBanner();
          const card = document.querySelector(`.monitor-card[data-id="${payload.id}"] .status-slot`);
          if (card) card.innerHTML = statusBadge(payload.status);
        }
      }
    } catch (e) {}
  };
  ws.onclose = () => setTimeout(connectWebSocket, 3000);
}

loadPageNav();
load();
connectWebSocket();
setInterval(load, 60000);
