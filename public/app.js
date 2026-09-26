// ---- Tabs ----
document.getElementById('tabs').addEventListener('click', (e) => {
  const btn = e.target.closest('.tab-btn');
  if (!btn) return;
  document.querySelectorAll('.tab-btn').forEach((b) => b.classList.toggle('active', b === btn));
  document.querySelectorAll('.tab-panel').forEach((p) => p.classList.toggle('active', p.id === `tab-${btn.dataset.tab}`));
});

function escapeHtml(str) {
  return String(str || '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

document.getElementById('logout-btn').addEventListener('click', async () => {
  await fetch('/api/logout', { method: 'POST' });
  window.location.href = '/login.html';
});

async function api(url, options) {
  const res = await fetch(url, options);
  if (res.status === 401) {
    window.location.href = '/login.html';
    throw new Error('unauthenticated');
  }
  return res;
}

// =========================================================
// Role-based access: admin (full access) / manager (create+edit,
// no delete, no user management) / user (read-only)
// =========================================================

let currentRole = 'admin';
let currentUserId = null;

function canWriteRole() {
  return currentRole === 'admin' || currentRole === 'manager';
}
function canDeleteRole() {
  return currentRole === 'admin';
}

async function loadSession() {
  const res = await api('/api/session');
  const data = await res.json();
  currentRole = data.role || 'admin';
  currentUserId = data.id || null;
  applyRoleUI();
  return data;
}

function applyRoleUI() {
  document.getElementById('users-tab-btn').style.display = currentRole === 'admin' ? '' : 'none';
  const allMonitorsLink = document.getElementById('all-monitors-link');
  if (allMonitorsLink) allMonitorsLink.style.display = currentRole === 'admin' ? '' : 'none';

  const writePanels = [
    document.getElementById('monitor-form').closest('.panel'),
    document.getElementById('notif-form').closest('.panel'),
    document.getElementById('sp-form').closest('.panel'),
    document.getElementById('maint-form').closest('.panel'),
    document.getElementById('branding-form').closest('.panel'),
  ];
  for (const panel of writePanels) {
    if (panel) panel.style.display = canWriteRole() ? '' : 'none';
  }
}

// =========================================================
// Monitors
// =========================================================

const typeSelect = document.getElementById('f-type');
const fieldMap = {
  url: document.getElementById('field-url'),
  host: document.getElementById('field-host'),
  port: document.getElementById('field-port'),
  keyword: document.getElementById('field-keyword'),
  keywordType: document.getElementById('field-keyword-type'),
  jsonpath: document.getElementById('field-jsonpath'),
  jsonexpected: document.getElementById('field-jsonexpected'),
  dnstype: document.getElementById('field-dnstype'),
  dnsexpected: document.getElementById('field-dnsexpected'),
  cert: document.getElementById('field-cert'),
};

const TYPE_FIELDS = {
  http: ['url', 'cert'],
  keyword: ['url', 'keyword', 'keywordType', 'cert'],
  json_query: ['url', 'jsonpath', 'jsonexpected', 'cert'],
  tcp: ['host', 'port'],
  dns: ['host', 'dnstype', 'dnsexpected'],
  ping: ['host'],
  websocket: ['url'],
};

function updateTypeFields() {
  const visible = TYPE_FIELDS[typeSelect.value] || ['url'];
  for (const key of Object.keys(fieldMap)) {
    fieldMap[key].style.display = visible.includes(key) ? '' : 'none';
  }
}
typeSelect.addEventListener('change', updateTypeFields);
updateTypeFields();

const form = document.getElementById('monitor-form');
const idField = document.getElementById('monitor-id');
const submitBtn = document.getElementById('submit-btn');
const cancelBtn = document.getElementById('cancel-edit');
const formTitle = document.getElementById('form-title');
const notifSelect = document.getElementById('f-notifications');

function resetForm() {
  form.reset();
  idField.value = '';
  submitBtn.textContent = 'Add Monitor';
  formTitle.textContent = 'Add Monitor';
  cancelBtn.style.display = 'none';
  updateTypeFields();
}
cancelBtn.addEventListener('click', resetForm);

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const tags = document.getElementById('f-tags').value.split(',').map((t) => t.trim()).filter(Boolean);
  const notificationIds = [...notifSelect.selectedOptions].map((o) => o.value);
  const payload = {
    name: document.getElementById('f-name').value.trim(),
    type: typeSelect.value,
    url: document.getElementById('f-url').value.trim(),
    host: document.getElementById('f-host').value.trim(),
    port: document.getElementById('f-port').value,
    interval: document.getElementById('f-interval').value,
    timeout: document.getElementById('f-timeout').value,
    retries: document.getElementById('f-retries').value,
    keyword: document.getElementById('f-keyword').value,
    keywordType: document.getElementById('f-keyword-type').value,
    jsonPath: document.getElementById('f-jsonpath').value,
    jsonExpected: document.getElementById('f-jsonexpected').value,
    dnsRecordType: document.getElementById('f-dnstype').value,
    dnsExpected: document.getElementById('f-dnsexpected').value,
    certCheck: document.getElementById('f-certcheck').checked,
    certExpiryThreshold: document.getElementById('f-cert-threshold').value,
    tags,
    notificationIds,
  };
  const id = idField.value;
  const url = id ? `/api/monitors/${id}` : '/api/monitors';
  const method = id ? 'PUT' : 'POST';
  const res = await api(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    alert(err.error || 'Failed to save monitor');
    return;
  }
  resetForm();
  loadMonitors();
});

function statusBadge(status) {
  const label = { up: 'Up', down: 'Down', pending: 'Pending', 'up-pending-retry': 'Pending', maintenance: 'Maintenance' }[status] || status;
  return `<span class="badge ${status}"><span class="dot"></span>${label}</span>`;
}

let monitorsCache = [];
let adminMonitorGrouping = 'none';
let adminSearchFilter = '';
let statusPagesCache = [];

async function loadMonitors() {
  const res = await api('/api/monitors');
  monitorsCache = await res.json();
  if (!statusPagesCache.length) {
    const pRes = await api('/api/statuspages');
    statusPagesCache = await pRes.json();
  }
  renderMonitorsTable();
  populateMonitorMultiSelects();
}

function renderMonitorRow(m) {
  const target = m.type === 'tcp' || m.type === 'dns' || m.type === 'ping' ? (m.host || m.url) : m.url;
  const lastCheck = m.lastCheck ? new Date(m.lastCheck).toLocaleString() : '-';
  const tags = (m.tags || []).map((t) => `<span class="tag-pill">${escapeHtml(t)}</span>`).join('');
  const editBtn = canWriteRole() ? `<button class="secondary" onclick="editMonitor('${m.id}')">Edit</button>` : '';
  const deleteBtn = canDeleteRole() ? `<button class="danger" onclick="deleteMonitor('${m.id}')">Delete</button>` : '';
  return `
    <tr>
      <td>${statusBadge(m.currentStatus)}</td>
      <td>${escapeHtml(m.name)}</td>
      <td class="muted">${escapeHtml(target)}</td>
      <td>${tags}</td>
      <td class="muted">${m.interval}s</td>
      <td class="muted">${lastCheck}</td>
      <td>
        <div class="row-actions">
          <button class="secondary" onclick="viewEvents('${m.id}')">Events</button>
          ${editBtn}
          ${deleteBtn}
        </div>
      </td>
    </tr>`;
}

function getMonitorStatusPage(monitorId) {
  const page = statusPagesCache.find((p) => (p.monitorIds || []).includes(monitorId));
  return page ? page.title : 'None';
}

function filterAdminMonitors(monitors) {
  if (!adminSearchFilter) return monitors;
  return monitors.filter((m) => m.name.toLowerCase().includes(adminSearchFilter));
}

function groupAdminMonitorsByStatus(monitors) {
  const groups = { up: [], down: [], pending: [], maintenance: [] };
  monitors.forEach((m) => {
    const key = ['up-pending-retry', 'pending'].includes(m.currentStatus) ? 'pending' : m.currentStatus;
    if (!groups[key]) groups[key] = [];
    groups[key].push(m);
  });
  return groups;
}

function groupAdminMonitorsByTags(monitors) {
  const groups = {};
  monitors.forEach((m) => {
    const tags = (m.tags || []).length ? m.tags : ['Untagged'];
    tags.forEach((tag) => {
      if (!groups[tag]) groups[tag] = [];
      groups[tag].push(m);
    });
  });
  return groups;
}

function groupAdminMonitorsByPage(monitors) {
  const groups = {};
  monitors.forEach((m) => {
    const page = getMonitorStatusPage(m.id);
    if (!groups[page]) groups[page] = [];
    groups[page].push(m);
  });
  return groups;
}

const STATUS_ORDER = { up: 0, maintenance: 1, pending: 2, down: 3 };
const STATUS_LABELS = { up: 'Up', down: 'Down', pending: 'Pending', maintenance: 'Maintenance' };

function normalizedStatus(m) {
  return ['up-pending-retry', 'pending'].includes(m.currentStatus) ? 'pending' : m.currentStatus;
}

function groupCountsHtml(monitors) {
  const up = monitors.filter((m) => normalizedStatus(m) === 'up').length;
  return `<span class="muted">(${up}/${monitors.length} up)</span>`;
}

function renderMonitorsTable() {
  const display = document.getElementById('monitors-display');
  if (!monitorsCache.length) {
    display.innerHTML = '<div class="panel empty">No monitors yet. Add one above.</div>';
    return;
  }

  const filtered = filterAdminMonitors(monitorsCache);
  if (!filtered.length) {
    display.innerHTML = '<div class="panel empty">No monitors match your search.</div>';
    return;
  }

  const tableHead = `<table style="width:100%;"><thead><tr>
    <th>Status</th><th>Name</th><th>Target</th><th>Tags</th><th>Interval</th><th>Last check</th><th></th>
  </tr></thead><tbody>`;

  let groups; // ordered array of { key, label, monitors }
  if (adminMonitorGrouping === 'status') {
    const byStatus = groupAdminMonitorsByStatus(filtered);
    groups = Object.keys(STATUS_ORDER)
      .sort((a, b) => STATUS_ORDER[a] - STATUS_ORDER[b])
      .filter((k) => (byStatus[k] || []).length)
      .map((k) => ({ key: k, label: STATUS_LABELS[k] || k, monitors: byStatus[k] }));
  } else if (adminMonitorGrouping === 'tags') {
    const byTag = groupAdminMonitorsByTags(filtered);
    groups = Object.keys(byTag)
      .sort((a, b) => a.localeCompare(b))
      .map((k) => ({ key: k, label: k, monitors: byTag[k] }));
  } else if (adminMonitorGrouping === 'page') {
    const byPage = groupAdminMonitorsByPage(filtered);
    groups = Object.keys(byPage)
      .sort((a, b) => a.localeCompare(b))
      .map((k) => ({ key: k, label: k, monitors: byPage[k] }));
  } else {
    groups = [{ key: 'all', label: null, monitors: [...filtered].sort((a, b) => a.name.localeCompare(b.name)) }];
  }

  let html = '';
  groups.forEach((g) => {
    const rows = g.monitors.map(renderMonitorRow).join('');
    if (!g.label) {
      html += `${tableHead}${rows}</tbody></table>`;
      return;
    }
    html += `
      <div class="monitor-group">
        <div class="group-header" onclick="this.classList.toggle('collapsed')">
          <span class="toggle-icon">▼</span>
          <span>${escapeHtml(g.label)}</span>
          ${groupCountsHtml(g.monitors)}
        </div>
        <div class="group-content">
          ${tableHead}${rows}</tbody></table>
        </div>
      </div>`;
  });

  display.innerHTML = html;
}

async function editMonitor(id) {
  const res = await api(`/api/monitors/${id}`);
  const m = await res.json();
  idField.value = m.id;
  document.getElementById('f-name').value = m.name;
  typeSelect.value = m.type;
  document.getElementById('f-url').value = m.url || '';
  document.getElementById('f-host').value = m.host || '';
  document.getElementById('f-port').value = m.port || '';
  document.getElementById('f-interval').value = m.interval;
  document.getElementById('f-timeout').value = m.timeout;
  document.getElementById('f-retries').value = m.retries;
  document.getElementById('f-keyword').value = m.keyword || '';
  document.getElementById('f-keyword-type').value = m.keywordType || 'contains';
  document.getElementById('f-jsonpath').value = m.jsonPath || '';
  document.getElementById('f-jsonexpected').value = m.jsonExpected || '';
  document.getElementById('f-dnstype').value = m.dnsRecordType || 'A';
  document.getElementById('f-dnsexpected').value = m.dnsExpected || '';
  document.getElementById('f-certcheck').checked = !!m.certCheck;
  document.getElementById('f-cert-threshold').value = m.certExpiryThreshold || 14;
  document.getElementById('f-tags').value = (m.tags || []).join(', ');
  [...notifSelect.options].forEach((o) => { o.selected = (m.notificationIds || []).includes(o.value); });
  updateTypeFields();
  submitBtn.textContent = 'Save Changes';
  formTitle.textContent = 'Edit Monitor';
  cancelBtn.style.display = '';
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

async function deleteMonitor(id) {
  if (!confirm('Delete this monitor? This removes its history too.')) return;
  await api(`/api/monitors/${id}`, { method: 'DELETE' });
  loadMonitors();
}

async function viewEvents(id) {
  const monitor = monitorsCache.find((m) => m.id === id);
  const res = await api(`/api/monitors/${id}/events`);
  const events = await res.json();
  document.getElementById('events-monitor-name').textContent = monitor ? monitor.name : '';
  document.getElementById('events-body').innerHTML = events
    .slice()
    .reverse()
    .map((e) => `<tr><td class="muted">${new Date(e.time).toLocaleString()}</td><td>${statusBadge(e.status)}</td><td>${escapeHtml(e.message)}</td></tr>`)
    .join('') || '<tr><td colspan="3" class="empty">No events yet</td></tr>';
  document.getElementById('events-panel').style.display = '';
  document.getElementById('events-panel').scrollIntoView({ behavior: 'smooth' });
}

// =========================================================
// Notifications
// =========================================================

const NOTIF_CONFIG_FIELDS = {
  webhook: [{ key: 'url', label: 'Webhook URL', placeholder: 'https://example.com/hook' }],
  slack: [{ key: 'webhookUrl', label: 'Slack Webhook URL', placeholder: 'https://hooks.slack.com/...' }],
  discord: [{ key: 'webhookUrl', label: 'Discord Webhook URL', placeholder: 'https://discord.com/api/webhooks/...' }],
  teams: [{ key: 'webhookUrl', label: 'Teams Incoming Webhook URL', placeholder: 'https://outlook.office.com/webhook/...' }],
  telegram: [
    { key: 'botToken', label: 'Bot Token', placeholder: '123456:ABC-DEF' },
    { key: 'chatId', label: 'Chat ID', placeholder: '-1001234567890' },
  ],
  email: [
    { key: 'host', label: 'SMTP Host', placeholder: 'smtp.example.com' },
    { key: 'port', label: 'SMTP Port', placeholder: '587' },
    { key: 'user', label: 'SMTP Username', placeholder: '' },
    { key: 'pass', label: 'SMTP Password', placeholder: '', type: 'password' },
    { key: 'from', label: 'From address', placeholder: 'alerts@example.com' },
    { key: 'to', label: 'To address', placeholder: 'you@example.com' },
  ],
};

const notifTypeSelect = document.getElementById('n-type');
const notifConfigFields = document.getElementById('notif-config-fields');
const notifForm = document.getElementById('notif-form');
const notifIdField = document.getElementById('n-id');
const notifSubmitBtn = document.getElementById('notif-submit-btn');
const notifCancelBtn = document.getElementById('notif-cancel');
const notifFormTitle = document.getElementById('notif-form-title');

function renderNotifConfigFields(values = {}) {
  const fields = NOTIF_CONFIG_FIELDS[notifTypeSelect.value] || [];
  notifConfigFields.innerHTML = fields
    .map(
      (f) => `
      <div>
        <label>${f.label}</label>
        <input data-key="${f.key}" type="${f.type || 'text'}" placeholder="${f.placeholder || ''}" value="${escapeHtml(values[f.key] || '')}" />
      </div>`
    )
    .join('');
}
notifTypeSelect.addEventListener('change', () => renderNotifConfigFields());
renderNotifConfigFields();

function resetNotifForm() {
  notifForm.reset();
  notifIdField.value = '';
  notifSubmitBtn.textContent = 'Add Channel';
  notifFormTitle.textContent = 'Add Notification Channel';
  notifCancelBtn.style.display = 'none';
  renderNotifConfigFields();
}
notifCancelBtn.addEventListener('click', resetNotifForm);

notifForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const config = {};
  notifConfigFields.querySelectorAll('input').forEach((input) => { config[input.dataset.key] = input.value; });
  const payload = { name: document.getElementById('n-name').value.trim(), type: notifTypeSelect.value, config };
  const id = notifIdField.value;
  const url = id ? `/api/notifications/${id}` : '/api/notifications';
  const method = id ? 'PUT' : 'POST';
  const res = await api(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    alert(err.error || 'Failed to save notification channel');
    return;
  }
  resetNotifForm();
  loadNotifications();
});

let notificationsCache = [];

async function loadNotifications() {
  const res = await api('/api/notifications');
  notificationsCache = await res.json();
  const body = document.getElementById('notif-body');
  body.innerHTML = notificationsCache.length
    ? notificationsCache
        .map(
          (n) => `
        <tr>
          <td>${escapeHtml(n.name)}</td>
          <td class="muted">${n.type}</td>
          <td>
            <div class="row-actions">
              <button class="secondary" onclick="testSavedNotification('${n.id}', this)">Send Test</button>
              ${canWriteRole() ? `<button class="secondary" onclick="editNotification('${n.id}')">Edit</button>` : ''}
              ${canDeleteRole() ? `<button class="danger" onclick="deleteNotification('${n.id}')">Delete</button>` : ''}
            </div>
          </td>
        </tr>`
        )
        .join('')
    : '<tr><td colspan="3" class="empty">No notification channels yet.</td></tr>';

  notifSelect.innerHTML = notificationsCache.map((n) => `<option value="${n.id}">${escapeHtml(n.name)} (${n.type})</option>`).join('');
}

function editNotification(id) {
  const n = notificationsCache.find((x) => x.id === id);
  if (!n) return;
  notifIdField.value = n.id;
  document.getElementById('n-name').value = n.name;
  notifTypeSelect.value = n.type;
  renderNotifConfigFields(n.config || {});
  notifSubmitBtn.textContent = 'Save Changes';
  notifFormTitle.textContent = 'Edit Notification Channel';
  notifCancelBtn.style.display = '';
}

async function deleteNotification(id) {
  if (!confirm('Delete this notification channel?')) return;
  await api(`/api/notifications/${id}`, { method: 'DELETE' });
  loadNotifications();
}

async function runNotificationTest(button, body) {
  const original = button.textContent;
  button.disabled = true;
  button.textContent = 'Sending...';
  try {
    const res = await api('/api/notifications/test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const result = await res.json().catch(() => ({}));
    if (result.ok) {
      alert('Test notification sent successfully.');
    } else {
      alert(`Test notification failed: ${result.error || 'Unknown error'}`);
    }
  } catch (e) {
    alert('Test notification failed: could not reach server.');
  } finally {
    button.disabled = false;
    button.textContent = original;
  }
}

function testSavedNotification(id, button) {
  const n = notificationsCache.find((x) => x.id === id);
  if (!n) return;
  runNotificationTest(button, { type: n.type, config: n.config });
}

document.getElementById('notif-test-btn').addEventListener('click', (e) => {
  const config = {};
  notifConfigFields.querySelectorAll('input').forEach((input) => { config[input.dataset.key] = input.value; });
  runNotificationTest(e.target, { type: notifTypeSelect.value, config });
});

// =========================================================
// Status Pages
// =========================================================

const spForm = document.getElementById('sp-form');
const spIdField = document.getElementById('sp-id');
const spMonitors = document.getElementById('sp-monitors');
const spSubmitBtn = document.getElementById('sp-submit-btn');
const spCancelBtn = document.getElementById('sp-cancel');
const spFormTitle = document.getElementById('sp-form-title');

function populateMonitorMultiSelects() {
  const opts = monitorsCache.map((m) => `<option value="${m.id}">${escapeHtml(m.name)}</option>`).join('');
  spMonitors.innerHTML = opts;
  document.getElementById('m-monitors').innerHTML = opts;
}

function resetSpForm() {
  spForm.reset();
  spIdField.value = '';
  spSubmitBtn.textContent = 'Create Page';
  spFormTitle.textContent = 'Create Status Page';
  spCancelBtn.style.display = 'none';
}
spCancelBtn.addEventListener('click', resetSpForm);

spForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const payload = {
    title: document.getElementById('sp-title').value.trim(),
    slug: document.getElementById('sp-slug').value.trim(),
    description: document.getElementById('sp-description').value.trim(),
    monitorIds: [...spMonitors.selectedOptions].map((o) => o.value),
    isPublic: document.getElementById('sp-is-public').checked,
  };
  const id = spIdField.value;
  const url = id ? `/api/statuspages/${id}` : '/api/statuspages';
  const method = id ? 'PUT' : 'POST';
  const res = await api(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    alert(err.error || 'Failed to save status page');
    return;
  }
  resetSpForm();
  loadStatusPages();
});

async function loadStatusPages() {
  const res = await api('/api/statuspages');
  statusPagesCache = await res.json();
  const body = document.getElementById('sp-body');
  body.innerHTML = statusPagesCache.length
    ? statusPagesCache
        .map(
          (p) => `
        <tr>
          <td>${escapeHtml(p.title)}</td>
          <td><a href="/status/${p.slug}" target="_blank" class="muted">/status/${escapeHtml(p.slug)}</a></td>
          <td class="muted">${p.monitorIds.length}</td>
          <td class="muted">${p.isPublic !== false ? '🌐 Public' : '🔒 Private'}</td>
          <td>
            <div class="row-actions">
              ${canWriteRole() ? `<button class="secondary" onclick="editStatusPage('${p.id}')">Edit</button>` : ''}
              ${canDeleteRole() ? `<button class="danger" onclick="deleteStatusPage('${p.id}')">Delete</button>` : ''}
            </div>
          </td>
        </tr>`
        )
        .join('')
    : '<tr><td colspan="5" class="empty">No status pages yet. Create one above and check "Publish on home page" to make it visible to the public.</td></tr>';
}

function editStatusPage(id) {
  const p = statusPagesCache.find((x) => x.id === id);
  if (!p) return;
  spIdField.value = p.id;
  document.getElementById('sp-title').value = p.title;
  document.getElementById('sp-slug').value = p.slug;
  document.getElementById('sp-description').value = p.description || '';
  [...spMonitors.options].forEach((o) => { o.selected = p.monitorIds.includes(o.value); });
  document.getElementById('sp-is-public').checked = p.isPublic !== false;
  spSubmitBtn.textContent = 'Save Changes';
  spFormTitle.textContent = 'Edit Status Page';
  spCancelBtn.style.display = '';
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

async function deleteStatusPage(id) {
  if (!confirm('Delete this status page?')) return;
  await api(`/api/statuspages/${id}`, { method: 'DELETE' });
  loadStatusPages();
}

// =========================================================
// Maintenance windows
// =========================================================

const maintForm = document.getElementById('maint-form');
maintForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const payload = {
    title: document.getElementById('m-title').value.trim(),
    start: new Date(document.getElementById('m-start').value).toISOString(),
    end: new Date(document.getElementById('m-end').value).toISOString(),
    monitorIds: [...document.getElementById('m-monitors').selectedOptions].map((o) => o.value),
  };
  const res = await api('/api/maintenance', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    alert(err.error || 'Failed to schedule maintenance');
    return;
  }
  maintForm.reset();
  loadMaintenance();
});

async function loadMaintenance() {
  const res = await api('/api/maintenance');
  const list = await res.json();
  const body = document.getElementById('maint-body');
  body.innerHTML = list.length
    ? list
        .map((w) => {
          const names = w.monitorIds.map((id) => monitorsCache.find((m) => m.id === id)?.name).filter(Boolean).join(', ');
          return `
          <tr>
            <td>${escapeHtml(w.title)}</td>
            <td class="muted">${escapeHtml(names)}</td>
            <td class="muted">${new Date(w.start).toLocaleString()}</td>
            <td class="muted">${new Date(w.end).toLocaleString()}</td>
            <td>${canDeleteRole() ? `<button class="danger" onclick="deleteMaintenance('${w.id}')">Delete</button>` : ''}</td>
          </tr>`;
        })
        .join('')
    : '<tr><td colspan="5" class="empty">No maintenance windows scheduled.</td></tr>';
}

async function deleteMaintenance(id) {
  await api(`/api/maintenance/${id}`, { method: 'DELETE' });
  loadMaintenance();
}

// =========================================================
// Security: password + 2FA
// =========================================================

document.getElementById('password-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const currentPassword = document.getElementById('p-current').value;
  const newPassword = document.getElementById('p-new').value;
  const res = await api('/api/change-password', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ currentPassword, newPassword }) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    alert(data.error || 'Failed to change password');
    return;
  }
  alert('Password updated');
  e.target.reset();
});

async function refreshTwoFactorStatus() {
  const res = await api('/api/session');
  const data = await res.json();
  const enabled = !!data.twoFactorEnabled;
  document.getElementById('twofa-status').textContent = enabled ? '2FA is currently enabled.' : '2FA is currently disabled.';
  document.getElementById('twofa-enable-btn').style.display = enabled ? 'none' : '';
  document.getElementById('twofa-disable-btn').style.display = enabled ? '' : 'none';
  document.getElementById('twofa-setup').style.display = 'none';
}

document.getElementById('twofa-enable-btn').addEventListener('click', async () => {
  const res = await api('/api/2fa/setup', { method: 'POST' });
  const data = await res.json();
  document.getElementById('twofa-qr').src = data.qrDataUrl;
  document.getElementById('twofa-setup').style.display = '';
});

document.getElementById('twofa-confirm-btn').addEventListener('click', async () => {
  const token = document.getElementById('twofa-token').value.trim();
  const res = await api('/api/2fa/confirm', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token }) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    alert(data.error || 'Invalid code');
    return;
  }
  alert('Two-factor authentication enabled');
  refreshTwoFactorStatus();
});

document.getElementById('twofa-disable-btn').addEventListener('click', async () => {
  if (!confirm('Disable two-factor authentication?')) return;
  await api('/api/2fa/disable', { method: 'POST' });
  refreshTwoFactorStatus();
});

// =========================================================
// Real-time updates via WebSocket (falls back to polling)
// =========================================================

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
          renderMonitorsTable();
        }
      }
    } catch (e) {}
  };
  ws.onclose = () => setTimeout(connectWebSocket, 3000);
}

// =========================================================
// Branding
// =========================================================

let brandingState = {};

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

function updateBrandingPreviews() {
  const logoPreview = document.getElementById('b-logo-preview');
  logoPreview.src = brandingState.logoUrl || '';
  logoPreview.style.display = brandingState.logoUrl ? '' : 'none';

  const faviconPreview = document.getElementById('b-favicon-preview');
  faviconPreview.src = brandingState.faviconUrl || '';
  faviconPreview.style.display = brandingState.faviconUrl ? '' : 'none';
}

async function loadBranding() {
  const res = await fetch('/api/branding');
  brandingState = await res.json();
  document.getElementById('b-sitename').value = brandingState.siteName || '';
  document.getElementById('b-accent').value = brandingState.accentColor || '#4f8cff';
  document.getElementById('b-footer').value = brandingState.footerText || '';
  document.getElementById('b-powered-by').checked = brandingState.showPoweredBy !== false;
  updateBrandingPreviews();
}

document.getElementById('b-logo-file').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  brandingState.logoUrl = await fileToDataUrl(file);
  updateBrandingPreviews();
});
document.getElementById('b-logo-clear').addEventListener('click', () => {
  brandingState.logoUrl = '';
  document.getElementById('b-logo-file').value = '';
  updateBrandingPreviews();
});
document.getElementById('b-favicon-file').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  brandingState.faviconUrl = await fileToDataUrl(file);
  updateBrandingPreviews();
});
document.getElementById('b-favicon-clear').addEventListener('click', () => {
  brandingState.faviconUrl = '';
  document.getElementById('b-favicon-file').value = '';
  updateBrandingPreviews();
});

document.getElementById('branding-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const payload = {
    siteName: document.getElementById('b-sitename').value.trim(),
    accentColor: document.getElementById('b-accent').value,
    logoUrl: brandingState.logoUrl || '',
    faviconUrl: brandingState.faviconUrl || '',
    footerText: document.getElementById('b-footer').value.trim(),
    showPoweredBy: document.getElementById('b-powered-by').checked,
  };
  const res = await api('/api/branding', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
  if (!res.ok) {
    alert('Failed to save branding');
    return;
  }
  alert('Branding saved');
  document.documentElement.style.setProperty('--accent', payload.accentColor);
});

// =========================================================
// Users (admin only)
// =========================================================

const userForm = document.getElementById('user-form');
userForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const payload = {
    username: document.getElementById('u-username').value.trim(),
    password: document.getElementById('u-password').value,
    role: document.getElementById('u-role').value,
  };
  const res = await api('/api/users', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    alert(data.error || 'Failed to create user');
    return;
  }
  userForm.reset();
  loadUsers();
});

async function loadUsers() {
  if (currentRole !== 'admin') return;
  const res = await api('/api/users');
  const list = await res.json();
  const body = document.getElementById('user-body');
  body.innerHTML = list.length
    ? list
        .map((u) => {
          const isSelf = u.id === currentUserId;
          const roleSelect = `
            <select onchange="changeUserRole('${u.id}', this.value)" ${isSelf ? 'disabled title="You cannot change your own role"' : ''}>
              <option value="user" ${u.role === 'user' ? 'selected' : ''}>User</option>
              <option value="manager" ${u.role === 'manager' ? 'selected' : ''}>Manager</option>
              <option value="admin" ${u.role === 'admin' ? 'selected' : ''}>Admin</option>
            </select>`;
          return `
          <tr>
            <td>${escapeHtml(u.username)}${isSelf ? ' <span class="muted">(you)</span>' : ''}</td>
            <td>${roleSelect}</td>
            <td class="muted">${u.twoFactorEnabled ? 'Enabled' : 'Disabled'}</td>
            <td class="muted">${u.createdAt ? new Date(u.createdAt).toLocaleDateString() : '-'}</td>
            <td>
              <div class="row-actions">
                <button class="secondary" onclick="resetUserPassword('${u.id}')">Reset Password</button>
                ${isSelf ? '' : `<button class="danger" onclick="deleteUser('${u.id}')">Delete</button>`}
              </div>
            </td>
          </tr>`;
        })
        .join('')
    : '<tr><td colspan="5" class="empty">No users yet.</td></tr>';
}

async function changeUserRole(id, role) {
  const res = await api(`/api/users/${id}/role`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ role }) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    alert(data.error || 'Failed to change role');
  }
  loadUsers();
}

async function resetUserPassword(id) {
  const newPassword = prompt('Enter a new password for this user (min 6 characters):');
  if (!newPassword) return;
  const res = await api(`/api/users/${id}/reset-password`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ newPassword }) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    alert(data.error || 'Failed to reset password');
    return;
  }
  alert('Password reset.');
}

async function deleteUser(id) {
  if (!confirm('Delete this user? They will lose access immediately.')) return;
  const res = await api(`/api/users/${id}`, { method: 'DELETE' });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    alert(data.error || 'Failed to delete user');
    return;
  }
  loadUsers();
}

// Admin monitors search and grouping
const adminGroupingToggle = document.getElementById('admin-grouping-toggle');
if (adminGroupingToggle) {
  adminGroupingToggle.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-group]');
    if (!btn) return;
    adminMonitorGrouping = btn.dataset.group;
    [...adminGroupingToggle.querySelectorAll('button')].forEach((b) => b.classList.toggle('active', b === btn));
    renderMonitorsTable();
  });
}

const adminMonitorSearch = document.getElementById('admin-monitor-search');
if (adminMonitorSearch) {
  adminMonitorSearch.addEventListener('input', (e) => {
    adminSearchFilter = e.target.value.toLowerCase();
    renderMonitorsTable();
  });
}

// =========================================================
// Init
// =========================================================

async function init() {
  await loadSession();
  await loadNotifications();
  await loadMonitors();
  await loadStatusPages();
  await loadMaintenance();
  await refreshTwoFactorStatus();
  await loadBranding();
  await loadUsers();
  connectWebSocket();
}
init();
setInterval(loadMonitors, 30000);
