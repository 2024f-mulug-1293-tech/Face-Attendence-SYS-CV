/**
 * ============================================================
 *  UI HELPERS — ui.js
 *  Toasts, Modals, Forms, Dates, Avatars, CSV, Print
 * ============================================================
 */
'use strict';

const UI = (() => {
  let _clockInterval = null;

  /* ── Internal helpers ─────────────────────────────────────── */
  const $ = id => document.getElementById(id);
  const make = (tag, cls, html = '') => {
    const el = document.createElement(tag);
    if (cls) el.className = cls;
    if (html) el.innerHTML = html;
    return el;
  };

  const escapeHTML = (str) => {
    if (!str) return '';
    return String(str).replace(/[&<>'"]/g, 
      tag => ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        "'": '&#39;',
        '"': '&quot;'
      }[tag] || tag)
    );
  };

  /* ══════════════════════════════════════════════════════════
     TOAST NOTIFICATIONS
  ══════════════════════════════════════════════════════════ */
  const TOAST_ICONS = { success:'✅', error:'❌', warning:'⚠️', info:'ℹ️' };
  const TOAST_COLORS = {
    success: 'var(--c-success)',
    error:   'var(--c-danger)',
    warning: 'var(--c-warning)',
    info:    'var(--c-primary)'
  };
  let toastContainer = null;

  function ensureToastContainer() {
    if (!toastContainer) {
      toastContainer = make('div', 'toast-container');
      toastContainer.id = 'toast-container';
      document.body.appendChild(toastContainer);
    }
    return toastContainer;
  }

  /* ══════════════════════════════════════════════════════════
     CONFIRM DIALOG STATE
  ══════════════════════════════════════════════════════════ */
  let _confirmResolve = null;

  return {
    escapeHTML,
    /* ─── TOAST ─────────────────────────────────────────────── */
    /**
     * Show a non-blocking toast notification.
     * @param {string} message
     * @param {'success'|'error'|'warning'|'info'} type
     * @param {number} duration  ms before auto-dismiss
     */
    toast(message, type = 'info', duration = 4000) {
      const container = ensureToastContainer();

      // Max 4 toasts — remove oldest
      while (container.children.length >= 4) container.firstChild.remove();

      const toast = make('div', `toast toast-${type}`);
      const accent = TOAST_COLORS[type] || TOAST_COLORS.info;
      toast.style.borderLeft = `4px solid ${accent}`;
      toast.innerHTML = `
        <span class="toast-icon">${TOAST_ICONS[type] || 'ℹ️'}</span>
        <span class="toast-message">${message}</span>
        <button class="toast-close" aria-label="Dismiss">✕</button>
        <div class="toast-progress"></div>`;

      const progress = toast.querySelector('.toast-progress');
      progress.style.transition = `width ${duration}ms linear`;
      progress.style.background = accent;

      toast.querySelector('.toast-close').onclick = () => dismiss();
      container.appendChild(toast);

      // Trigger animation on next frame
      requestAnimationFrame(() => {
        toast.classList.add('show');
        requestAnimationFrame(() => { progress.style.width = '0%'; });
      });

      const dismiss = () => {
        toast.classList.remove('show');
        setTimeout(() => toast.remove(), 350);
      };

      const timer = setTimeout(dismiss, duration);
      toast.querySelector('.toast-close').addEventListener('click', () => clearTimeout(timer));
    },

    /* ─── MODAL ─────────────────────────────────────────────── */
    showModal(id) {
      const el = $(id);
      if (el) { el.classList.add('show'); el.removeAttribute('hidden'); }
    },
    hideModal(id) {
      const el = $(id);
      if (el) el.classList.remove('show');
    },

    /* ─── LOADING OVERLAY ────────────────────────────────────── */
    showLoading(msg = 'Loading…') {
      const ov = $('loading-overlay');
      if (ov) { ov.querySelector?.('#loading-status') && ($('loading-status').textContent = msg); ov.removeAttribute('hidden'); }
    },
    hideLoading() {
      const ov = $('loading-overlay');
      if (ov) ov.setAttribute('hidden', '');
    },

    /* ─── CONFIRM DIALOG ─────────────────────────────────────── */
    /**
     * Show a custom confirm dialog.
     * @returns {Promise<boolean>}
     */
    confirm(title, message, confirmText = 'Confirm', dangerMode = false) {
      return new Promise(resolve => {
        _confirmResolve = resolve;
        const dlg = $('confirm-dialog');
        if (!dlg) { resolve(window.confirm(`${title}\n${message}`)); return; }

        const t = dlg.querySelector('#confirm-title');
        const m = dlg.querySelector('#confirm-message');
        const b = dlg.querySelector('#confirm-ok');
        if (t) t.textContent = title;
        if (m) m.textContent = message;
        if (b) {
          b.textContent = confirmText;
          b.className   = `btn ${dangerMode ? 'btn-danger' : 'btn-primary'}`;
        }
        dlg.classList.add('show');
      });
    },

    confirmResolve(val) {
      const dlg = $('confirm-dialog');
      if (dlg) dlg.classList.remove('show');
      if (_confirmResolve) { _confirmResolve(val); _confirmResolve = null; }
    },

    /* ─── FORM HELPERS ───────────────────────────────────────── */
    getFormData(formId) {
      const form = $(formId) || document.querySelector(`#${formId}`);
      if (!form) return {};
      const out = {};
      form.querySelectorAll('[name]').forEach(el => { out[el.name] = el.value.trim(); });
      return out;
    },
    clearForm(formId) {
      const form = $(formId);
      if (form) form.reset();
    },
    setFormData(formId, data) {
      const form = $(formId);
      if (!form) return;
      Object.entries(data).forEach(([k, v]) => {
        const el = form.querySelector(`[name="${k}"]`);
        if (el) el.value = v;
      });
    },

    /* ─── DATE / TIME HELPERS ────────────────────────────────── */
    formatDate(str) {
      if (!str) return '—';
      try { return new Date(str + 'T00:00:00').toLocaleDateString('en-US', { month:'long', day:'numeric', year:'numeric' }); }
      catch { return str; }
    },
    formatTime(str) {
      if (!str) return '—';
      try {
        const [h, m] = str.split(':');
        const d = new Date(); d.setHours(+h, +m);
        return d.toLocaleTimeString('en-US', { hour:'numeric', minute:'2-digit' });
      } catch { return str; }
    },
    formatDateTime(ts) {
      if (!ts) return '—';
      try {
        const d = ts.toDate ? ts.toDate() : new Date(ts);
        return d.toLocaleString('en-US', { month:'short', day:'numeric', year:'numeric', hour:'numeric', minute:'2-digit' });
      } catch { return '—'; }
    },
    todayDateString() {
      return new Date().toISOString().slice(0, 10);
    },
    nowTimeString() {
      const d = new Date();
      return `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
    },
    timeAgo(ts) {
      if (!ts) return '';
      const d = ts.toDate ? ts.toDate() : new Date(ts);
      const s = Math.round((Date.now() - d.getTime()) / 1000);
      if (s < 60) return 'just now';
      if (s < 3600) return `${Math.floor(s/60)}m ago`;
      if (s < 86400) return `${Math.floor(s/3600)}h ago`;
      return `${Math.floor(s/86400)}d ago`;
    },

    /* ─── AVATAR ─────────────────────────────────────────────── */
    getAvatarDataUrl(name = '?', size = 40) {
      const initials = name.split(' ').slice(0,2).map(w => w[0]).join('').toUpperCase();
      const colors = ['#4f8ef7','#10b981','#8b5cf6','#f59e0b','#ef4444','#3b82f6','#06b6d4'];
      const bg = colors[name.charCodeAt(0) % colors.length];
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}"><rect width="${size}" height="${size}" rx="${size/2}" fill="${bg}"/><text x="${size/2}" y="${size*0.64}" font-family="Inter,Arial" font-size="${size*0.38}" fill="#fff" text-anchor="middle" font-weight="600">${initials}</text></svg>`;
      return `data:image/svg+xml;base64,${btoa(svg)}`;
    },

    /* ─── STATUS BADGE ───────────────────────────────────────── */
    statusBadge(text, type = 'info') {
      const map = { success:'badge-success', error:'badge-danger', warning:'badge-warning', info:'badge-info', open:'badge-success', closed:'badge-secondary', superadmin:'badge-primary', teacher:'badge-info', pending:'badge-warning' };
      return `<span class="badge ${map[type] || 'badge-info'}">${text}</span>`;
    },

    /* ─── CONFIDENCE ─────────────────────────────────────────── */
    confidenceColor(pct) {
      if (pct >= 75) return 'var(--c-success)';
      if (pct >= 50) return 'var(--c-warning)';
      return 'var(--c-danger)';
    },
    confidenceLabel(pct) {
      if (pct >= 80) return 'High';
      if (pct >= 60) return 'Medium';
      return 'Low';
    },

    /* ─── EMPTY STATE ────────────────────────────────────────── */
    emptyState(icon = '📋', title = 'Nothing here', subtitle = '') {
      return `<div class="empty-state"><div class="empty-icon">${icon}</div><div class="empty-title">${title}</div>${subtitle ? `<div class="empty-sub">${subtitle}</div>` : ''}</div>`;
    },

    /* ─── SKELETON LOADER ────────────────────────────────────── */
    skeletonList(count = 3) {
      return Array.from({ length: count }, () =>
        `<div class="skeleton-row"><div class="skeleton avatar-skel"></div><div class="skeleton-lines"><div class="skeleton line-skel w70"></div><div class="skeleton line-skel w45"></div></div></div>`
      ).join('');
    },

    /* ─── CSV EXPORT ─────────────────────────────────────────── */
    downloadCSV(filename, headers, rows) {
      const escape = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
      const lines  = [headers.map(escape).join(','), ...rows.map(r => r.map(escape).join(','))];
      const blob   = new Blob([lines.join('\r\n')], { type: 'text/csv;charset=utf-8;' });
      const url    = URL.createObjectURL(blob);
      const a      = document.createElement('a');
      a.href = url; a.download = filename; a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    },

    /* ─── PRINT ──────────────────────────────────────────────── */
    printSection(htmlContent, title = 'Report') {
      const win = window.open('', '_blank');
      win.document.write(`<!DOCTYPE html><html><head><title>${title}</title><style>
        body{font-family:Inter,Arial,sans-serif;padding:24px;color:#111}
        table{width:100%;border-collapse:collapse}
        th,td{border:1px solid #ddd;padding:8px 12px;text-align:left}
        th{background:#f3f4f6;font-weight:600}
        h1{font-size:20px;margin-bottom:16px}
        @media print{body{padding:0}}
      </style></head><body><h1>${title}</h1>${htmlContent}</body></html>`);
      win.document.close();
      win.focus();
      setTimeout(() => win.print(), 500);
    },

    /* ─── CLOCK ──────────────────────────────────────────────── */
    startClock(elementId) {
      const el = $(elementId);
      if (!el) return;
      const tick = () => {
        el.textContent = new Date().toLocaleTimeString('en-US', { hour:'numeric', minute:'2-digit', second:'2-digit' });
      };
      tick();
      _clockInterval = setInterval(tick, 1000);
    },
    stopClock() {
      if (_clockInterval) { clearInterval(_clockInterval); _clockInterval = null; }
    },

    /* ─── MISC ───────────────────────────────────────────────── */
    setHTML(id, html)    { const el = $(id); if (el) el.innerHTML = html; },
    setText(id, text)    { const el = $(id); if (el) el.textContent = text; },
    show(id)             { const el = $(id); if (el) el.removeAttribute('hidden'); },
    hide(id)             { const el = $(id); if (el) el.setAttribute('hidden',''); },
    toggleHidden(id, v)  { v ? this.show(id) : this.hide(id); },
    addClass(id, cls)    { const el = $(id); if (el) el.classList.add(cls); },
    removeClass(id, cls) { const el = $(id); if (el) el.classList.remove(cls); }
  };
})();

window.UI = UI;
