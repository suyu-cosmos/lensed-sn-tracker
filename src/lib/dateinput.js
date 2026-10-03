// Year-first date fields. A native <input type="date"> always *displays* in
// the viewer's locale (dd/mm/yyyy, mm/dd/yyyy, …), which a page can't
// change — so every date field is a plain text box in yyyy-mm-dd (the same
// ISO form the data is stored and shown in), plus a 📅 button that opens a
// small calendar of our own (plain buttons, so it works the same in every
// browser — an invisible native picker behind the icon did not). The form
// value is the text box's, so nothing downstream changes.

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
  } /><button type="button" class="date-pick" title="Pick a date" aria-label="Pick a date">📅</button></span>`;
}

/**
 * HTML for a UTC date + time field ("yyyy-mm-dd hh:mm"), for a logged observation's
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

// ---------- the calendar popup ----------

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const pad = (n) => String(n).padStart(2, '0');
const iso = (y, m, d) => `${y}-${pad(m + 1)}-${pad(d)}`; // m is 0-based
const todayIso = () => new Date().toISOString().slice(0, 10);

/** HTML for one month (Monday-first), with `selected`/today marked. */
export function calendarHtml(year, month, selected) {
  const first = new Date(Date.UTC(year, month, 1));
  const lead = (first.getUTCDay() + 6) % 7; // Monday = 0
  const days = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  const today = todayIso();
  const cells = [];
  for (let i = 0; i < lead; i++) cells.push('<span></span>');
  for (let d = 1; d <= days; d++) {
    const value = iso(year, month, d);
    const cls = [value === selected ? 'selected' : '', value === today ? 'today' : ''].filter(Boolean).join(' ');
    cells.push(`<button type="button" data-day="${value}"${cls ? ` class="${cls}"` : ''}>${d}</button>`);
  }
  return `
    <div class="cal-head">
      <button type="button" data-step="-1" aria-label="Previous month">‹</button>
      <span>${MONTHS[month]} ${year}</span>
      <button type="button" data-step="1" aria-label="Next month">›</button>
    </div>
    <div class="cal-grid">${['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'].map((d) => `<span class="cal-dow">${d}</span>`).join('')}${cells.join('')}</div>
    <div class="cal-foot"><button type="button" data-day="${today}">Today</button><button type="button" data-clear>Clear</button></div>`;
}

let open = null; // { popup, text, year, month }

function closeCalendar() {
  open?.popup.remove();
  open = null;
}

function setValue(text, value) {
  text.value = value;
  text.dispatchEvent(new Event('input', { bubbles: true }));
  text.dispatchEvent(new Event('change', { bubbles: true }));
}

function openCalendar(button) {
  const text = button.closest('.date-field')?.querySelector('.date-text');
  if (!text) return;
  closeCalendar();
  const current = /^\d{4}-\d{2}-\d{2}$/.test(text.value) ? text.value : todayIso();
  const popup = document.createElement('div');
  popup.className = 'cal-popup';
  popup.setAttribute('role', 'dialog');
  popup.setAttribute('aria-label', 'Choose a date');
  document.body.appendChild(popup);
  open = { popup, text, year: Number(current.slice(0, 4)), month: Number(current.slice(5, 7)) - 1 };
  const draw = () => (popup.innerHTML = calendarHtml(open.year, open.month, text.value));
  draw();

  // Fixed position under the button (tables scroll sideways, which would clip an absolute popup).
  const r = button.getBoundingClientRect();
  const width = popup.offsetWidth || 240;
  popup.style.left = `${Math.max(8, Math.min(r.right - width, window.innerWidth - width - 8))}px`;
  popup.style.top = `${r.bottom + 4}px`;

  popup.addEventListener('click', (event) => {
    event.stopPropagation();
    const target = event.target.closest('button');
    if (!target) return;
    if (target.dataset.step) {
      open.month += Number(target.dataset.step);
      if (open.month < 0) (open.month = 11), open.year--;
      if (open.month > 11) (open.month = 0), open.year++;
      draw();
    } else if (target.dataset.day) {
      setValue(text, target.dataset.day);
      closeCalendar();
      text.focus();
    } else if ('clear' in target.dataset) {
      setValue(text, '');
      closeCalendar();
      text.focus();
    }
  });
}

/**
 * Wire every date field's 📅 under `root`, once, by event delegation.
 * Clicking outside, Escape, scrolling or resizing closes the calendar.
 */
export function installDatePickers(root = document) {
  root.addEventListener('click', (event) => {
    const button = event.target.closest?.('.date-pick');
    if (button) {
      event.preventDefault(); // inside a <label>, don't also focus the text box
      if (open && open.text === button.closest('.date-field')?.querySelector('.date-text')) closeCalendar();
      else openCalendar(button);
      return;
    }
    if (open && !open.popup.contains(event.target)) closeCalendar();
  });
  root.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') closeCalendar();
  });
  window.addEventListener('resize', closeCalendar);
  window.addEventListener('scroll', closeCalendar, true);
}
