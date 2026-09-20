(async function applyBranding() {
  let branding;
  try {
    const res = await fetch('/api/branding');
    branding = await res.json();
  } catch (e) {
    return;
  }
  if (!branding) return;

  if (branding.accentColor) {
    document.documentElement.style.setProperty('--accent', branding.accentColor);
  }

  if (branding.faviconUrl) {
    let link = document.querySelector('link[rel="icon"]');
    if (!link) {
      link = document.createElement('link');
      link.rel = 'icon';
      document.head.appendChild(link);
    }
    link.href = branding.faviconUrl;
  }

  const brandSlot = document.querySelector('[data-brand-name]');
  if (brandSlot && branding.siteName) brandSlot.textContent = branding.siteName;

  const logoSlot = document.querySelector('[data-brand-logo]');
  if (logoSlot) {
    if (branding.logoUrl) {
      logoSlot.src = branding.logoUrl;
      logoSlot.style.display = '';
    } else {
      logoSlot.style.display = 'none';
    }
  }

  if (branding.siteName && document.title) {
    document.title = document.title === 'System Status' || document.title.includes('Uptime Monitor')
      ? document.title.replace(/Uptime Monitor/, branding.siteName)
      : document.title;
  }

  const footerSlot = document.querySelector('[data-brand-footer]');
  if (footerSlot) {
    const parts = [];
    if (branding.footerText) parts.push(escapeHtmlLocal(branding.footerText));
    if (branding.showPoweredBy) parts.push('Powered by Uptime Monitor');
    footerSlot.innerHTML = parts.join(' &middot; ');
    footerSlot.style.display = parts.length ? '' : 'none';
  }

  function escapeHtmlLocal(str) {
    return String(str || '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  window.__branding = branding;
})();
