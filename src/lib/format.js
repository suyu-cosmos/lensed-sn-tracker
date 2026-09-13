// Small formatting helpers shared by every page. Kept dependency-free since
// the plan calls for keeping the app's dependency list short.

export function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

/** All times default to UT display per config.json's `defaultTimeDisplay`. */
export function formatUtc(date) {
  if (!date) return '—';
  const d = date instanceof Date ? date : new Date(date);
  return `${d.toISOString().slice(0, 16).replace('T', ' ')} UT`;
}

export function formatMinutes(minutes) {
  if (!minutes) return '0 min';
  const h = Math.floor(minutes / 60);
  const m = Math.round(minutes % 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

const KNOWN_COLORS = new Set(['gray', 'amber', 'green', 'red']);

export function statusPillHtml(status) {
  if (!status) return '<span class="pill unknown">unknown status</span>';
  const color = KNOWN_COLORS.has(status.color) ? status.color : 'gray';
  return `<span class="pill ${color}">${escapeHtml(status.label)}</span>`;
}
