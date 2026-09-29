// Vitest coverage for the Milestone-2 write payload builders (write.js).
// These are pure functions (no network), so they're cheap to check against
// what parseIssueBody would read back — the round-trip is exactly what
// matters, since it's what keeps app-created issues and hand-filed ones
// interchangeable.

import { describe, it, expect } from 'vitest';
import { buildCandidateIssue, buildTaskIssue, buildTriggerMailto } from '../src/lib/write.js';
import { parseIssueBody } from '../src/lib/yaml.js';

describe('buildCandidateIssue', () => {
  it('round-trips through parseIssueBody with matching title/labels', () => {
    const fields = {
      id: 'LSN-test',
      tnsName: 'SN test',
      discoverySurvey: 'LSST',
      discoveryDate: '2026-01-01',
      raDeg: 10,
      decDeg: 20,
      lensName: 'Test lens',
      zLens: 0.4,
      lensType: 'galaxy',
      nImages: 4,
      zSource: 1.0,
      snType: 'unknown',
      leads: ['suyu-cosmos'],
      status: 'new_candidate',
    };
    const { title, body, labels } = buildCandidateIssue(fields);

    expect(title).toBe('[LSN-test] SN test');
    expect(labels).toEqual(['type:candidate', 'status:new_candidate', 'cand:LSN-test']);

    const { data } = parseIssueBody(body);
    expect(data.id).toBe('LSN-test');
    expect(data.ra_deg).toBe(10);
    expect(data.dec_deg).toBe(20);
    expect(data.leads).toEqual(['suyu-cosmos']);
    expect(data.status).toBe('new_candidate');
    expect(data.lens.z_lens).toBe(0.4);
  });
});

describe('buildTaskIssue', () => {
  it('builds a trigger sub-issue with cand: and facility: labels', () => {
    const { title, body, labels } = buildTaskIssue('LSN-test', 'trigger', {
      facility: 'vlt',
      instrument: 'xshooter',
      mode: 'spectroscopy',
      requestedDate: '2026-09-20',
      images: ['A', 'B'],
    });

    expect(title).toBe('[LSN-test] trigger: vlt/xshooter');
    expect(labels).toEqual(['type:trigger', 'cand:LSN-test', 'facility:vlt']);

    const { data } = parseIssueBody(body);
    expect(data.cand).toBe('LSN-test');
    expect(data.pi_contacted).toBe(false);
    expect(data.exposure).toBeNull(); // not collected by the app's form on purpose — left for the PI/automation to fill in
    expect(data.images).toEqual(['A', 'B']);
  });

  it('builds a trigger sub-issue with a filter band, for single_filter instruments like WFI', () => {
    const { body } = buildTaskIssue('LSN-test', 'trigger', {
      facility: 'mpg22',
      instrument: 'wfi',
      mode: 'imaging',
      filterBand: 'R',
      requestedDate: '2026-09-20',
      images: [],
    });
    const { data } = parseIssueBody(body);
    expect(data.filter).toBe('R');
  });

  it('builds an observation sub-issue preserving the filters/setup key', () => {
    const { body } = buildTaskIssue('LSN-test', 'observation', {
      facility: 'keck',
      instrument: 'lris',
      obsUtc: '2026-09-20T05:00:00Z',
      filtersSetup: 'slit 1.0"',
      conditions: 'clear',
      dataLocation: '/data',
      reductionStatus: 'raw',
    });
    const { data } = parseIssueBody(body);
    expect(data['filters/setup']).toBe('slit 1.0"');
    expect(data.reduction_status).toBe('raw');
  });

  it('builds an analysis sub-issue with no facility label', () => {
    const { labels } = buildTaskIssue('LSN-test', 'analysis', { product: 'lightcurve', result: '', files: [] });
    expect(labels).toEqual(['type:analysis', 'cand:LSN-test']);
  });

  it('builds a decision sub-issue from the summary/deadline/options fields', () => {
    const { title, body } = buildTaskIssue('LSN-test', 'decision', {
      summary: 'which facility to trigger?',
      deadline: '2026-10-01',
      options: ['vlt', 'keck'],
    });
    expect(title).toBe('[LSN-test] decision: which facility to trigger?');
    const { data } = parseIssueBody(body);
    expect(data.options).toEqual(['vlt', 'keck']);
  });
});

describe('buildTriggerMailto', () => {
  const peopleData = {
    people: [
      { id: 'pi1', name: 'PI One', email: 'pi1@example.org' },
      { id: 'pi2', name: 'PI Two', email: 'pi2@example.org' },
      { id: 'lead1', name: 'Spec Lead', email: 'lead1@example.org' },
      { id: 'photlead1', name: 'Phot Lead', email: 'photlead1@example.org' },
      { id: 'coord1', name: 'Coordinator', email: 'coord1@example.org' },
    ],
    roles: {
      spectroscopy_lead: { holder: 'lead1' },
      photometry_lead: { holder: 'photlead1' },
      coordinator: { holder: 'coord1' },
    },
  };
  const candidate = { id: 'LSN-test', tns_name: 'SN test', ra_deg: 10, dec_deg: 20 };
  const facility = { name: 'Test Facility', contact: { email: 'facility@example.org', pi: 'pi1' } };

  it('emails the facility PI, CCs spectroscopy_lead + coordinator for a spectroscopy trigger', () => {
    const { url, to, cc } = buildTriggerMailto({
      candidate,
      facility,
      instrument: { name: 'Test Spectrograph' },
      mode: 'spectroscopy',
      visibilityTonight: { visible: false },
      peopleData,
    });

    expect(to.id).toBe('pi1');
    expect(cc.map((p) => p.id).sort()).toEqual(['coord1', 'lead1']);
    expect(url).toMatch(/^mailto:pi1@example\.org\?/);
    const decoded = decodeURIComponent(url);
    expect(decoded).toContain('Coordinates (J2000): RA 10°, Dec 20°');
    expect(decoded).toContain('Not visible tonight');
    expect(decoded).toContain('cc=');
  });

  it("CCs photometry_lead instead, for an imaging trigger", () => {
    const { cc } = buildTriggerMailto({
      candidate,
      facility,
      instrument: { name: 'Test Imager' },
      mode: 'imaging',
      visibilityTonight: null,
      peopleData,
    });
    expect(cc.map((p) => p.id).sort()).toEqual(['coord1', 'photlead1']);
  });

  it("an instrument's own pi: overrides the facility-level contact.pi", () => {
    const { to } = buildTriggerMailto({
      candidate,
      facility,
      instrument: { name: 'Test Instrument', pi: 'pi2' },
      mode: 'spectroscopy',
      visibilityTonight: null,
      peopleData,
    });
    expect(to.id).toBe('pi2');
  });

  it("a candidate's roles_override wins for the CC'd lead, same as everywhere else in the app", () => {
    const { cc } = buildTriggerMailto({
      candidate: { ...candidate, roles_override: { spectroscopy_lead: 'photlead1' } },
      facility,
      instrument: { name: 'Test Instrument' },
      mode: 'spectroscopy',
      visibilityTonight: null,
      peopleData,
    });
    expect(cc.map((p) => p.id)).toContain('photlead1');
    expect(cc.map((p) => p.id)).not.toContain('lead1');
  });

  it('does not duplicate the PI in the CC list when they also hold a CC role', () => {
    const { to, cc } = buildTriggerMailto({
      candidate,
      facility: { ...facility, contact: { ...facility.contact, pi: 'coord1' } },
      instrument: { name: 'Test Instrument' },
      mode: 'spectroscopy',
      visibilityTonight: null,
      peopleData,
    });
    expect(to.id).toBe('coord1');
    expect(cc.map((p) => p.id)).not.toContain('coord1');
  });
});
