let currentRange = '30';
let currentGrouping = 'group';
let currentView = 'vertical';
let searchFilter = '';
let monitorsCache = [];
let allowedMonitorIds = null; // null on the admin-only default page = show every monitor

const RANGE_LABELS = {
  hourly: 'last 24h',
  daily: 'today',
  '7': '7d',
  '30': '30d',
  '45': '45d',
  '90': '90d',
};

const isDefaultPage = /^\/status\.html$/.test(window.location.pathname);
const slugMatch = window.location.pathname.match(/^\/status\/([^/]+)/);
let slug = slugMatch ? decodeURIComponent(slugMatch[1]) : null;
// Bare "/status" (no slug, not the admin default page) auto-resolves to
// whichever single named status page exists, or shows an index/empty state.
const isRootStatus = !isDefaultPage && !slug;

const rangeToggle = document.getElementById('range-toggle');
rangeToggle.addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-range]');
  if (!btn) return;
  currentRange = btn.dataset.range;
  [...rangeToggle.querySelectorAll('button')].forEach((b) => b.classList.toggle('active', b === btn));
  renderMonitors();
});

const groupingToggle = document.getElementById('grouping-toggle');
if (groupingToggle) {
  groupingToggle.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-group]');
    if (!btn) return;
    currentGrouping = btn.dataset.group;
    [...groupingToggle.querySelectorAll('button')].forEach((b) => b.classList.toggle('active', b === btn));
    renderMonitors();
  });
}

const viewToggle = document.getElementById('view-toggle');
if (viewToggle) {
  viewToggle.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-view]');
    if (!btn) return;
    currentView = btn.dataset.view;
    [...viewToggle.querySelectorAll('button')].forEach((b) => b.classList.toggle('active', b === btn));
    renderMonitors();
  });
}

const monitorSearch = document.getElementById('monitor-search');
if (monitorSearch) {
  monitorSearch.addEventListener('input', (e) => {
    searchFilter = e.target.value.toLowerCase();
    renderMonitors();
  });
}

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

function renderMonitorCard(d) {
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
}

function renderMonitorRowHorizontal(d) {
  const tags = (d.tags || []).map((t) => `<span class="tag-pill">${escapeHtml(t)}</span>`).join('');
  const rangeLabel = RANGE_LABELS[d.range] || RANGE_LABELS[currentRange] || '';
  return `
    <div class="monitor-row-h" data-id="${d.id}">
      <div class="monitor-row-h-info">
        ${statusBadge(d.currentStatus)}
        <span class="name">${escapeHtml(d.name)}</span>
        ${tags}
        <span class="muted">Uptime (${rangeLabel}): <b>${fmtPct(d.uptimePercent)}</b></span>
      </div>
      <div class="bars">${renderBars(d.series)}</div>
    </div>`;
}

function renderMonitorItem(d) {
  return currentView === 'horizontal' ? renderMonitorRowHorizontal(d) : renderMonitorCard(d);
}

function groupMonitorsByStatus(details) {
  const groups = { up: [], down: [], pending: [], maintenance: [] };
  details.forEach((d) => {
    const key = ['up-pending-retry', 'pending'].includes(d.currentStatus) ? 'pending' : d.currentStatus;
    if (!groups[key]) groups[key] = [];
    groups[key].push(d);
  });
  return groups;
}

// Groups nest via "/" in the monitor's Group field, e.g. "APAC/Mooments SG".
function buildGroupTree(details) {
  const root = { children: {}, monitors: [] };
  details.forEach((d) => {
    const path = (d.group || '').split('/').map((s) => s.trim()).filter(Boolean);
    const segs = path.length ? path : ['Ungrouped'];
    let node = root;
    segs.forEach((seg) => {
      if (!node.children[seg]) node.children[seg] = { name: seg, children: {}, monitors: [] };
      node = node.children[seg];
    });
    node.monitors.push(d);
  });
  return root;
}

function collectNodeMonitors(node) {
  let all = [...node.monitors];
  Object.values(node.children).forEach((c) => { all = all.concat(collectNodeMonitors(c)); });
  return all;
}

function renderGroupNode(node, depth) {
  const childNames = Object.keys(node.children).sort((a, b) => (a === 'Ungrouped' ? 1 : b === 'Ungrouped' ? -1 : a.localeCompare(b)));
  let html = '';
  childNames.forEach((name) => {
    const child = node.children[name];
    const all = collectNodeMonitors(child);
    const up = all.filter((d) => (['up-pending-retry', 'pending'].includes(d.currentStatus) ? 'pending' : d.currentStatus) === 'up').length;
    const allUp = up === all.length;
    const inner = renderGroupNode(child, depth + 1) + child.monitors.map(renderMonitorItem).join('');
    html += `
      <div class="monitor-group" style="margin-left:${depth * 20}px;">
        <div class="group-header${allUp ? ' collapsed' : ''}" onclick="this.classList.toggle('collapsed')">
          <span class="toggle-icon">▼</span>
          <span>${escapeHtml(name)}</span>
          <span class="muted">(${up}/${all.length} up)</span>
        </div>
        <div class="group-content">${inner}</div>
      </div>`;
  });
  return html;
}

function groupMonitorsByTags(details) {
  const groups = {};
  details.forEach((d) => {
    const tags = (d.tags || ['Untagged']).length ? d.tags : ['Untagged'];
    tags.forEach((tag) => {
      if (!groups[tag]) groups[tag] = [];
      groups[tag].push(d);
    });
  });
  return groups;
}

function filterMonitors(details) {
  if (!searchFilter) return details;
  return details.filter((d) => d.name.toLowerCase().includes(searchFilter));
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

  for (const d of details) {
    const m = monitorsCache.find((x) => x.id === d.id);
    if (m) {
      m.currentStatus = d.currentStatus;
      m.lastCheck = d.lastCheck;
    }
  }
  renderBanner();

  const filtered = filterMonitors(details);
  if (!filtered.length) {
    list.innerHTML = '<div class="panel empty">No monitors match your search.</div>';
    return;
  }

  let html = '';
  if (currentGrouping === 'none') {
    const sorted = [...filtered].sort((a, b) => a.name.localeCompare(b.name));
    html = sorted.map(renderMonitorItem).join('');
  } else if (currentGrouping === 'group') {
    const tree = buildGroupTree(filtered);
    html += `<div class="group-collapse-all" style="margin-bottom:12px;">
      <button class="secondary" onclick="document.querySelectorAll('#monitors-list .group-header').forEach((h) => h.classList.remove('collapsed'))">Expand all</button>
      <button class="secondary" onclick="document.querySelectorAll('#monitors-list .group-header').forEach((h) => h.classList.add('collapsed'))">Collapse all</button>
    </div>`;
    html += renderGroupNode(tree, 0);
  } else {
    const STATUS_ORDER = { up: 0, maintenance: 1, pending: 2, down: 3 };
    const STATUS_LABELS = { up: 'Operational', down: 'Down', pending: 'Pending', maintenance: 'Maintenance' };
    let groups;
    if (currentGrouping === 'status') {
      const byStatus = groupMonitorsByStatus(filtered);
      groups = Object.keys(STATUS_ORDER)
        .sort((a, b) => STATUS_ORDER[a] - STATUS_ORDER[b])
        .filter((k) => (byStatus[k] || []).length)
        .map((k) => ({ label: STATUS_LABELS[k] || k, monitors: byStatus[k] }));
    } else {
      const byTag = groupMonitorsByTags(filtered);
      groups = Object.keys(byTag)
        .sort((a, b) => a.localeCompare(b))
        .map((k) => ({ label: k, monitors: byTag[k] }));
    }

    html += `<div class="group-collapse-all" style="margin-bottom:12px;">
      <button class="secondary" onclick="document.querySelectorAll('#monitors-list .group-header').forEach((h) => h.classList.remove('collapsed'))">Expand all</button>
      <button class="secondary" onclick="document.querySelectorAll('#monitors-list .group-header').forEach((h) => h.classList.add('collapsed'))">Collapse all</button>
    </div>`;

    groups.forEach((g) => {
      const up = g.monitors.filter((d) => (['up-pending-retry', 'pending'].includes(d.currentStatus) ? 'pending' : d.currentStatus) === 'up').length;
      const allUp = up === g.monitors.length;
      const cards = g.monitors.map(renderMonitorItem).join('');
      html += `
        <div class="monitor-group">
          <div class="group-header${allUp ? ' collapsed' : ''}" onclick="this.classList.toggle('collapsed')">
            <span class="toggle-icon">▼</span>
            <span>${escapeHtml(g.label)}</span>
            <span class="muted">(${up}/${g.monitors.length} up)</span>
          </div>
          <div class="group-content">${cards}</div>
        </div>`;
    });
  }
  list.innerHTML = html;
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
  // No "All monitors" entry here on purpose — that view is admin-only now.
  // With one page or fewer there's nothing to switch between, so skip the nav.
  if (pages.length < 2) return;
  const links = pages.map(
    (p) => `<a href="/status/${p.slug}" class="${slug === p.slug ? '' : 'muted'}">${escapeHtml(p.title)}</a>`
  );
  nav.innerHTML = links.join(' &nbsp;|&nbsp; ');
  nav.style.display = '';
}

function showEmptyState(message) {
  document.getElementById('overall-banner').innerHTML = '';
  document.querySelector('.range-toggle').closest('.panel').style.display = 'none';
  document.getElementById('monitors-list').innerHTML = `<div class="panel empty">${escapeHtml(message)}</div>`;
}

async function resolvePage(forSlug) {
  const res = await fetch(`/api/public/statuspages/${encodeURIComponent(forSlug)}`);
  if (!res.ok) return null;
  const page = await res.json();
  allowedMonitorIds = page.monitorIds;
  monitorsCache = page.monitorIds.map((id) => ({ id }));
  document.getElementById('page-title').textContent = page.title;
  document.title = page.title;
  if (page.description) {
    document.getElementById('page-description').textContent = page.description;
    document.getElementById('page-description').style.display = '';
  }
  return page;
}

async function load() {
  if (isRootStatus) {
    const res = await fetch('/api/public/statuspages');
    const pages = await res.json();
    if (pages.length === 0) {
      showEmptyState('No public status page has been configured yet.');
      return;
    }
    if (pages.length > 1) {
      document.getElementById('page-title').textContent = 'Status Pages';
      document.getElementById('overall-banner').innerHTML = '';
      document.querySelector('.range-toggle').closest('.panel').style.display = 'none';
      document.getElementById('monitors-list').innerHTML = `<div class="panel">
        <h2>Choose a status page</h2>
        <ul>${pages.map((p) => `<li><a href="/status/${p.slug}">${escapeHtml(p.title)}</a></li>`).join('')}</ul>
      </div>`;
      return;
    }
    slug = pages[0].slug; // exactly one page — resolve it directly under the clean /status URL
  }

  if (slug) {
    const page = await resolvePage(slug);
    if (!page) {
      showEmptyState('This status page could not be found.');
      return;
    }
    await renderMonitors();
    return;
  }

  // Admin-only default page (/status.html): full monitor list.
  const res = await fetch('/api/status');
  if (res.status === 401 || res.status === 403) {
    window.location.href = '/login.html';
    return;
  }
  monitorsCache = await res.json();
  renderBanner();
  await renderMonitors();
}

async function updateMonitorCard(monitorId) {
  try {
    const response = await fetch(`/api/status/${monitorId}?range=${currentRange}`);
    if (!response.ok) return;
    const detail = await response.json();

    const m = monitorsCache.find((x) => x.id === monitorId);
    if (m) {
      m.currentStatus = detail.currentStatus;
      m.lastCheck = detail.lastCheck;
    }

    const el = document.querySelector(`[data-id="${monitorId}"]`);
    if (el) el.outerHTML = renderMonitorItem(detail);
    renderBanner();
  } catch (e) {
    console.error('Failed to update monitor card:', e);
  }
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
          updateMonitorCard(payload.id);
        }
      }
    } catch (e) {}
  };
  ws.onclose = () => setTimeout(connectWebSocket, 3000);
}

if (!isRootStatus) loadPageNav();
load();
connectWebSocket();
setInterval(load, 30000);
