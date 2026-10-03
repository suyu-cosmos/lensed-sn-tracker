// @vitest-environment jsdom
// Year-first date fields (dateinput.js): the form value is always yyyy-mm-dd.

import { describe, it, expect } from 'vitest';
import { dateInputHtml, utcDateTimeValue, installDatePickers } from '../src/lib/dateinput.js';

describe('date fields', () => {
  it('render a named yyyy-mm-dd text box with its value', () => {
    const el = document.createElement('div');
    el.innerHTML = dateInputHtml('detected:B', '2026-10-05');
    const text = el.querySelector('input.date-text');
    expect(text.name).toBe('detected:B');
    expect(text.value).toBe('2026-10-05');
    expect(text.placeholder).toBe('yyyy-mm-dd');
    expect(el.querySelector('input.date-native').name).toBe(''); // never submitted itself
  });

  it('copy a date picked in the calendar into the text box and announce it as input', () => {
    installDatePickers(document);
    const form = document.createElement('form');
    form.innerHTML = dateInputHtml('until');
    document.body.appendChild(form);
    let inputs = 0;
    form.addEventListener('input', (e) => e.target.classList.contains('date-text') && inputs++);
    const native = form.querySelector('.date-native');
    native.value = '2026-12-01';
    native.dispatchEvent(new Event('change', { bubbles: true }));
    expect(new FormData(form).get('until')).toBe('2026-12-01');
    expect(inputs).toBe(1);
  });

  it('utcDateTimeValue turns "yyyy-mm-dd hh:mm" into an ISO UTC timestamp', () => {
    expect(utcDateTimeValue('2026-10-05 04:30')).toBe('2026-10-05T04:30:00Z');
    expect(utcDateTimeValue('2026-10-05T04:30')).toBe('2026-10-05T04:30:00Z');
    expect(utcDateTimeValue('  ')).toBeNull();
  });
});
