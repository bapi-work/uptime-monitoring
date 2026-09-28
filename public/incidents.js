function escapeHtml(str) {
  return String(str || '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

const IMPACT_LABELS = { minor: 'Minor', major: 'Major', critical: 'Critical', maintenance: 'Maintenance' };
const STATUS_LABELS = { investigating: 'Investigating', identified: 'Identified', monitoring: 'Monitoring', resolved: 'Resolved' };

function fmtDateTime(iso) {
  return new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
}

function monthLabel(iso) {
  return new Date(iso).toLocaleString(undefined, { month: 'long', year: 'numeric' });
}

function renderIncident(inc) {
  const affected = inc.affected.length
    ? `<div class="muted" style="margin-bottom:8px;">Affected: ${inc.affected
        .map((a) => `<span class="tag-pill">${escapeHtml(a.name)}${a.target ? ` <span style="opacity:0.7">(${escapeHtml(a.target)})</span>` : ''}</span>`)
        .join(' ')}</div>`
    : '';
  const timeline = [...inc.updates]
    .sort((a, b) => new Date(b.time) - new Date(a.time))
    .map((u) => `
      <div class="incident-update">
        <div><b>${STATUS_LABELS[u.status] || u.status}</b> <span class="muted">— ${fmtDateTime(u.time)}</span></div>
        <div>${escapeHtml(u.message)}</div>
      </div>`)
    .join('');
  const rootCause = inc.status === 'resolved' && inc.rootCause
    ? `<div class="incident-rootcause"><h4>Root cause analysis</h4><p>${escapeHtml(inc.rootCause).replace(/\n/g, '<br>')}</p></div>`
    : '';

  return `
    <div class="incident-card">
      <div class="incident-head">
        <h3>${escapeHtml(inc.title)}</h3>
        <span class="badge impact-${inc.impact}">${IMPACT_LABELS[inc.impact] || inc.impact}</span>
      </div>
      ${affected}
      <div class="incident-timeline">${timeline}</div>
      ${rootCause}
    </div>`;
}

async function load() {
  const list = document.getElementById('incidents-list');
  const res = await fetch('/api/public/incidents');
  if (!res.ok) {
    list.innerHTML = '<div class="panel empty">Could not load incident history.</div>';
    return;
  }
  const incidents = await res.json();
  if (!incidents.length) {
    list.innerHTML = '<div class="panel empty">No incidents have been reported.</div>';
    return;
  }

  const groups = {};
  incidents.forEach((inc) => {
    const key = monthLabel(inc.createdAt);
    if (!groups[key]) groups[key] = [];
    groups[key].push(inc);
  });

  list.innerHTML = Object.keys(groups)
    .map((month) => `
      <div class="incident-month">
        <h2>${escapeHtml(month)}</h2>
        ${groups[month].map(renderIncident).join('')}
      </div>`)
    .join('');
}

load();
