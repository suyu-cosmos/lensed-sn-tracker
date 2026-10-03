// Year-first date fields. A native <input type="date"> always *displays* in
// the viewer's locale (dd/mm/yyyy, mm/dd/yyyy, …), which a page can't
// change — so every date field is a plain text box in yyyy-mm-dd (the same
// ISO form the data is stored and shown in), plus a 📅 button that opens the
// browser's own calendar via a hidden native date input. The form value is
// the text box's, so nothing downstream changes.

import { escapeHtml } from './format.js';

const DATE_PATTERN = '\\d{4}-\\d{2}-\\d{2}';

/**
 * HTML for one date field. `attrs`: { required, ariaLabel, className }.
 * The text input carries `name`, so FormData sees 'YYYY-MM-DD' (or '').
 */
export function dateInputHtml(name, value = '', attrs = {}) {
  const label = attrs.ariaLabel ? ` aria-label="${escapeHtml(attrs.ariaLabel)}"` : '';
  return `<span class="date-field${attrs.className ? ` ${escapeHtml(attrs.className)}` : ''}"><input type="text" class="date-text" name="${escapeHtml(name)}" value="${escapeHtml(value ?? '')}" placeholder="yyyy-mm-dd" pattern="${DATE_PATTERN}" title="Date as yyyy-mm-dd, e.g. 2026-10-05" inputmode="numeric" maxlength="10" autocomplete="off"${label}${
    attrs.required ? ' required' : ''
  } /><span class="date-pick" title="Pick a date">📅<input type="date" class="date-native" tabindex="-1" aria-hidden="true" /></span></span>`;
}

/**
 * HTML for a UTC date + time field ("yyyy-mm-dd hh:mm"), for an observation's
 * time. Read it back with `utcDateTimeValue`.
 */
export function utcDateTimeInputHtml(name) {
  return `<input type="text" name="${escapeHtml(name)}" placeholder="yyyy-mm-dd hh:mm" pattern="\\d{4}-\\d{2}-\\d{2}[ T]\\d{2}:\\d{2}" title="UTC date and time as yyyy-mm-dd hh:mm, e.g. 2026-10-05 04:30" autocomplete="off" />`;
}

/** "2026-10-05 04:30" → "2026-10-05T04:30:00Z" (or null for blank). */
export function utcDateTimeValue(raw) {
  const text = String(raw ?? '').trim();
  if (!text) return null;
  const m = text.match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2})/);
  return m ? `${m[1]}T${m[2]}:00Z` : text;
}

/**
 * Wire every date field under `root`, once, by event delegation: the hidden
 * native input sits over the 📅 icon so a real click reaches it (Safari/
 * Firefox open their calendar on click); `showPicker()` covers Chrome. A
 * picked date is written into the text box and announced with an `input`
 * event, so live previews and "form is dirty" tracking see it like typing.
 */
export function installDatePickers(root = document) {
  root.addEventListener('click', (event) => {
    const native = event.target.closest?.('.date-native');
    if (!native) return;
    const text = native.closest('.date-field')?.querySelector('.date-text');
    if (text && /^\d{4}-\d{2}-\d{2}$/.test(text.value)) native.value = text.value;
    try {
      native.showPicker?.();
    } catch {
      /* not supported / not allowed — the native click still opens it where it can */
    }
  });
  root.addEventListener('change', (event) => {
    const native = event.target.closest?.('.date-native');
    if (!native) return;
    const text = native.closest('.date-field')?.querySelector('.date-text');
    if (!text || !native.value) return;
    text.value = native.value; // always yyyy-mm-dd, whatever the display locale
    text.dispatchEvent(new Event('input', { bubbles: true }));
    text.dispatchEvent(new Event('change', { bubbles: true }));
  });
}
