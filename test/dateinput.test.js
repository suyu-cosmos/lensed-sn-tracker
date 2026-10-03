// @vitest-environment jsdom
// Year-first date fields (dateinput.js): the form value is always yyyy-mm-dd.

import { describe, it, expect } from 'vitest';
import { dateInputHtml, utcDateTimeValue, installDatePickers, calendarHtml } from '../src/lib/dateinput.js';

describe('date fields', () => {
  it('render a named yyyy-mm-dd text box with its value', () => {
    const el = document.createElement('div');
    el.innerHTML = dateInputHtml('detected:B', '2026-10-05');
    const text = el.querySelector('input.date-text');
    expect(text.name).toBe('detected:B');
    expect(text.value).toBe('2026-10-05');
    expect(text.placeholder).toBe('yyyy-mm-dd');
  });

  it('the 📅 opens a calendar; picking a day fills the text box (announced as input) and closes it', () => {
    installDatePickers(document);
    const form = document.createElement('form');
    form.innerHTML = `<label>Until ${dateInputHtml('until', '2026-10-05')}</label>`;
    document.body.appendChild(form);
    let inputs = 0;
    form.addEventListener('input', (e) => e.target.classList.contains('date-text') && inputs++);

    form.querySelector('.date-pick').click();
    const popup = document.querySelector('.cal-popup');
    expect(popup.textContent).toContain('October 2026');
    expect(popup.querySelector('button.selected').dataset.day).toBe('2026-10-05');

    popup.querySelector('[data-step="1"]').click(); // next month
    expect(popup.textContent).toContain('November 2026');
    popup.querySelector('[data-day="2026-11-03"]').click();
    expect(new FormData(form).get('until')).toBe('2026-11-03');
    expect(inputs).toBe(1);
    expect(document.querySelector('.cal-popup')).toBeNull();

    form.querySelector('.date-pick').click();
    document.body.click(); // outside click closes
    expect(document.querySelector('.cal-popup')).toBeNull();
  });

  it('calendarHtml starts weeks on Monday', () => {
    const el = document.createElement('div');
    el.innerHTML = calendarHtml(2026, 9, null); // October 2026 starts on a Thursday
    const grid = [...el.querySelector('.cal-grid').children].slice(7);
    expect(grid.findIndex((c) => c.dataset?.day === '2026-10-01')).toBe(3);
  });

  it('utcDateTimeValue turns "yyyy-mm-dd hh:mm" into an ISO UTC timestamp', () => {
    expect(utcDateTimeValue('2026-10-05 04:30')).toBe('2026-10-05T04:30:00Z');
    expect(utcDateTimeValue('2026-10-05T04:30')).toBe('2026-10-05T04:30:00Z');
    expect(utcDateTimeValue('  ')).toBeNull();
  });
});
