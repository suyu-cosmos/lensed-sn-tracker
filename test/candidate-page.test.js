// @vitest-environment jsdom
// Candidate page, Milestone 2.6: logging a night on a trigger, adding archival
// data, and the Observation log that lists both. Inline fixtures only (CI
// checks out just this repo).

import { describe, it, expect, vi } from 'vitest';
import { parseIssueBody, stringifyIssueBody } from '../src/lib/yaml.js';
import { render } from '../src/pages/candidate.js';

const rules = {
  visibility: { sun_altitude_max_deg: -12, moon_separation_min_deg: 30, default_max_airmass: 2, min_window_minutes: 30, lookahead_nights: 1 },
  statuses: [{ id: 'lensed_sn', label: 'Live follow-up', tracks: ['phot_monitoring'] }],
  tracks: [{ id: 'phot_monitoring', label: 'Photometric monitoring', short: 'Phot', role: 'photometry_lead', task_type: 'trigger', modes: ['imaging'] }],
  vocabularies: { archival_sources: ['LSST', 'ZTF'] },
};
const people = {
  people: [{ id: 'stefant', name: 'Stefan Taubenberger' }, { id: 'piperson', name: 'Pat Pi' }],
  roles: { photometry_lead: { holder: 'stefant' }, main_lead: { holder: 'stefant' } },
};
const facilities = [
  { id: 'mpg22', name: 'MPG 2.2m', short: 'MPG 2.2m', space_based: true, contact: { pi: 'piperson' }, instruments: [{ id: 'grond', name: 'GROND', modes: ['imaging'] }] },
];
const tick = () => new Promise((r) => setTimeout(r, 20));

function setup() {
  const candData = { id: 'X', ra_deg: 10, dec_deg: -20, status: 'lensed_sn', image_dates: {} };
  const trigger = {
    number: 5,
    state: 'open',
    title: '[X] trigger: mpg22/grond',
    html_url: 'https://github.com/o/r/issues/5',
    labels: [{ name: 'type:trigger' }, { name: 'cand:X' }, { name: 'track:phot_monitoring' }],
    assignees: [],
    body: stringifyIssueBody({ cand: 'X', track: 'phot_monitoring', facility: 'mpg22', instrument: 'grond', mode: 'imaging', requested_date: '2026-01-01', observations: [] }, '', 'trigger'),
  };
  const issues = {
    listForRepo: {},
    listComments: {},
    get: vi.fn(async ({ issue_number }) => ({ data: issue_number === 5 ? trigger : null })),
    update: vi.fn(async ({ issue_number, body }) => {
      if (issue_number === 5) trigger.body = body;
      return {};
    }),
    create: vi.fn(async ({ title, body, labels, assignees }) => ({
      data: { number: 6, state: 'open', title, body, html_url: 'https://github.com/o/r/issues/6', labels: labels.map((name) => ({ name })), assignees: assignees.map((login) => ({ login })) },
    })),
  };
  const client = { paginate: vi.fn(async (fn, p) => (p.labels ? [trigger] : [])), rest: { issues } };
  const candidate = { issue: { number: 1, title: 'X', labels: [], html_url: '', state: 'open' }, data: candData, notes: '' };
  const ctx = { client, config: { dataRepo: { owner: 'o', name: 'r' } }, facilities, people, rules, candidates: [candidate] };
  const container = document.createElement('div');
  document.body.appendChild(container);
  return { ctx, container, issues, trigger };
}

describe('candidate page — observing records (M2.6)', () => {
  it('"+ Log observation" appends a night to the trigger and shows it on the card and in the Observation log', async () => {
    const { ctx, container, issues, trigger } = setup();
    await render(container, ctx, { id: 'X' });
    expect(container.querySelector('#image-timeline-card')).not.toBeNull();

    container.querySelector('[data-log-obs="5"]').click();
    const form = container.querySelector('.log-obs-form');
    form.querySelector('[name="obsUtc"]').value = '2026-10-02 03:30';
    form.querySelector('[name="setup"]').value = 'g,r,i,z,J,H,K';
    form.requestSubmit();
    await tick();

    expect(issues.update).toHaveBeenCalledTimes(1);
    expect(parseIssueBody(trigger.body).data.observations).toEqual([
      { obs_utc: '2026-10-02T03:30:00Z', setup: 'g,r,i,z,J,H,K', conditions: null, data_location: '', reduction_status: 'raw' },
    ]);
    expect(container.querySelector('.track-card').textContent).toContain('1 night observed · last 2026-10-02');
    // A trigger with data logged is never shown as overdue, even past its requested date.
    expect(container.querySelector('li.task-line').classList.contains('state-overdue')).toBe(false);
    const log = container.querySelector('table.obs-log').textContent;
    expect(log).toContain('2026-10-02 03:30');
    expect(log).toContain('GROND');
  });

  it('rejects a log entry without a valid UTC time', async () => {
    const { ctx, container, issues } = setup();
    await render(container, ctx, { id: 'X' });
    container.querySelector('[data-log-obs="5"]').click();
    const form = container.querySelector('.log-obs-form');
    // The field's pattern stops a malformed time before submit…
    form.querySelector('[name="obsUtc"]').value = 'yesterday';
    expect(form.checkValidity()).toBe(false);
    // …and an empty one is caught by the app's own check.
    form.querySelector('[name="obsUtc"]').value = '';
    form.requestSubmit();
    await tick();
    expect(issues.update).not.toHaveBeenCalled();
    expect(form.querySelector('.error').textContent).toMatch(/yyyy-mm-dd hh:mm/);
  });

  it('Archival observations: free-text source, assigned to the track lead only, tagged on the card, listed in the log', async () => {
    const { ctx, container, issues } = setup();
    await render(container, ctx, { id: 'X' });
    const form = container.querySelector('#add-task-form');
    const track = form.querySelector('select[name="track"]');
    track.value = 'phot_monitoring';
    track.dispatchEvent(new Event('change'));
    const type = form.querySelector('select[name="type"]');
    expect([...type.options].map((o) => o.textContent)).toEqual(['Trigger observation', 'Archival observations', 'Analysis', 'Decision']);
    type.value = 'archival';
    type.dispatchEvent(new Event('change'));
    expect(form.querySelector('[data-role="track-hint"]').textContent).toBe('Will be assigned to Stefan Taubenberger (photometry_lead).');
    expect([...container.querySelectorAll('#archival-sources option')].map((o) => o.value)).toEqual(['LSST', 'ZTF']);

    form.querySelector('[name="source"]').value = 'LSST';
    form.querySelector('[name="archivalInstrument"]').value = 'ugrizy';
    form.querySelector('[name="dateStart"]').value = '2026-09-01';
    form.querySelector('[name="dateEnd"]').value = '2026-10-01';
    form.requestSubmit();
    await tick();

    const created = issues.create.mock.calls[0][0];
    expect(created.assignees).toEqual(['stefant']);
    expect(created.labels).toEqual(['type:archival', 'cand:X', 'track:phot_monitoring']);
    expect(parseIssueBody(created.body).data).toMatchObject({ source: 'LSST', instrument: 'ugrizy', date_start: '2026-09-01', date_end: '2026-10-01' });

    const card = container.querySelector('.track-card').textContent;
    expect(card).toContain('archival');
    expect(card).toContain('LSST · ugrizy');
    expect(container.querySelector('table.obs-log').textContent).toContain('2026-09-01 – 2026-10-01');
  });

  it('Archival observations need a source', async () => {
    const { ctx, container, issues } = setup();
    await render(container, ctx, { id: 'X' });
    const form = container.querySelector('#add-task-form');
    form.querySelector('select[name="track"]').value = 'phot_monitoring';
    form.querySelector('select[name="track"]').dispatchEvent(new Event('change'));
    form.querySelector('select[name="type"]').value = 'archival';
    form.querySelector('select[name="type"]').dispatchEvent(new Event('change'));
    form.requestSubmit();
    await tick();
    expect(issues.create).not.toHaveBeenCalled();
    expect(form.querySelector('#add-task-error').textContent).toMatch(/Source/);
  });
});
