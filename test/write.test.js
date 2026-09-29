// Vitest coverage for the Milestone-2 write payload builders (write.js).
// These are pure functions (no network), so they're cheap to check against
// what parseIssueBody would read back — the round-trip is exactly what
// matters, since it's what keeps app-created issues and hand-filed ones
// interchangeable.

import { describe, it, expect, vi } from 'vitest';
import {
  buildCandidateIssue,
  buildTaskIssue,
  buildTriggerMailto,
  changeCandidateStatus,
  deepMerge,
  updateCandidateFields,
  setTaskTrack,
} from '../src/lib/write.js';
import { parseIssueBody, stringifyIssueBody } from '../src/lib/yaml.js';

/** A fake Octokit client whose issue has the given body data + label names. */
function mockClient(data, labelNames) {
  const issues = {
    get: vi.fn(async () => ({
      data: { body: stringifyIssueBody(data, '', 'candidate'), labels: labelNames.map((name) => ({ name })) },
    })),
    update: vi.fn(async () => ({})),
    addLabels: vi.fn(async () => ({})),
    removeLabel: vi.fn(async () => ({})),
  };
  return { client: { rest: { issues } }, issues };
}

describe('changeCandidateStatus', () => {
  const repo = { owner: 'o', name: 'r' };
  const candidate = { issue: { number: 11 } };

  it('removes every other status:* label, not just the one named in the body', async () => {
    // Reproduces the drift seen on a real issue: body says lensed_sn, but a
    // stale status:awaiting_confirmation label is still attached too.
    const { client, issues } = mockClient({ id: 'X', status: 'lensed_sn' }, [
      'type:candidate',
      'status:awaiting_confirmation',
      'status:lensed_sn',
      'cand:X',
    ]);
    const next = await changeCandidateStatus(client, repo, candidate, 'post_fade');

    expect(next.status).toBe('post_fade');
    expect(issues.addLabels).toHaveBeenCalledWith(expect.objectContaining({ labels: ['status:post_fade'] }));
    const removed = issues.removeLabel.mock.calls.map(([args]) => args.name).sort();
    expect(removed).toEqual(['status:awaiting_confirmation', 'status:lensed_sn']);
  });

  it("still removes the body's old status label even if the label list is stale", async () => {
    const { client, issues } = mockClient({ id: 'X', status: 'new_candidate' }, ['type:candidate']);
    await changeCandidateStatus(client, repo, candidate, 'awaiting_confirmation');
    expect(issues.removeLabel.mock.calls.map(([args]) => args.name)).toEqual(['status:new_candidate']);
  });

  it('never removes non-status labels or the new status label', async () => {
    const { client, issues } = mockClient({ id: 'X', status: 'lensed_sn' }, [
      'type:candidate',
      'priority:high',
      'cand:X',
      'status:lensed_sn',
    ]);
    await changeCandidateStatus(client, repo, candidate, 'lensed_sn');
    expect(issues.removeLabel).not.toHaveBeenCalled();
  });
});

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

describe('Milestone 2.5 track fields', () => {
  const rules = { tracks: [{ id: 'phot_monitoring', role: 'photometry_lead' }] };
  const peopleData = {
    people: [{ id: 'stefant' }, { id: 'other' }],
    roles: { photometry_lead: { holder: 'stefant' } },
  };

  it('new candidates get the full time_delays shape and an empty image_dates', () => {
    const { body } = buildCandidateIssue({ id: 'X', raDeg: 0, decDeg: 0, leads: ['a'], status: 'new_candidate' });
    const { data } = parseIssueBody(body);
    expect(data.time_delays).toEqual({ reference_image: 'A', predicted: {}, predicted_err: {}, measured: {}, measured_err: {} });
    expect(data.image_dates).toEqual({});
  });

  it('a tracked trigger defaults its role from the track, adds track:<id>, and resolves the assignee', () => {
    const { title, body, labels, assignees } = buildTaskIssue(
      'X',
      'trigger',
      { track: 'phot_monitoring', cadenceDays: 1, until: '2026-12-01', facility: 'mpg22', instrument: 'grond', mode: 'imaging', images: [] },
      { rules, candidate: { id: 'X' }, peopleData },
    );
    const { data } = parseIssueBody(body);
    expect(data).toMatchObject({ track: 'phot_monitoring', role: 'photometry_lead', cadence_days: 1, until: '2026-12-01', image: null });
    expect(labels).toContain('track:phot_monitoring');
    expect(assignees).toEqual(['stefant']);
    expect(title).toBe('[X] trigger: mpg22/grond');
  });

  it("a candidate's roles_override picks the assignee, and a per-image task names its image", () => {
    const { title, assignees } = buildTaskIssue(
      'X',
      'trigger',
      { track: 'phot_monitoring', image: 'B', facility: 'vlt', instrument: 'muse', mode: 'ifu', images: [] },
      { rules, candidate: { roles_override: { photometry_lead: 'other' } }, peopleData },
    );
    expect(assignees).toEqual(['other']);
    expect(title).toBe('[X] trigger: vlt/muse (image B)');
  });

  it('untracked tasks still work with no context (backward compatible)', () => {
    const { labels, assignees, body } = buildTaskIssue('X', 'analysis', { product: 'lightcurve', result: '', files: [] });
    expect(labels).toEqual(['type:analysis', 'cand:X']);
    expect(assignees).toEqual([]);
    expect(parseIssueBody(body).data.track).toBeNull();
  });

  it('observations carry an epochs list', () => {
    const { body } = buildTaskIssue('X', 'observation', { facility: 'vlt', instrument: 'soxs' });
    expect(parseIssueBody(body).data.epochs).toEqual([]);
  });
});

describe('deepMerge', () => {
  it('merges nested objects, replaces arrays/scalars, and does not mutate inputs', () => {
    const base = { image_dates: { A: { detected: 'a', peak: null } }, leads: ['x'], n: 1 };
    const out = deepMerge(base, { image_dates: { A: { peak: 'p' }, B: { detected: 'b' } }, leads: ['y'] });
    expect(out).toEqual({ image_dates: { A: { detected: 'a', peak: 'p' }, B: { detected: 'b' } }, leads: ['y'], n: 1 });
    expect(base.image_dates.A.peak).toBeNull();
  });
});

describe('updateCandidateFields', () => {
  const repo = { owner: 'o', name: 'r' };
  const candidate = { issue: { number: 7 } };

  it('deep-merges the patch into the fresh body and returns the new data', async () => {
    const { client, issues } = mockClient({ id: 'X', status: 'lensed_sn', image_dates: { A: { detected: '2026-09-01' } } }, []);
    const next = await updateCandidateFields(client, repo, candidate, { image_dates: { B: { detected: '2026-09-10' } } });
    expect(next.image_dates).toEqual({ A: { detected: '2026-09-01' }, B: { detected: '2026-09-10' } });
    expect(next.status).toBe('lensed_sn');
    const written = parseIssueBody(issues.update.mock.calls[0][0].body).data;
    expect(written.image_dates.B.detected).toBe('2026-09-10');
  });

  it('refuses to change status (that must go through changeCandidateStatus)', async () => {
    const { client } = mockClient({ id: 'X', status: 'lensed_sn' }, []);
    await expect(updateCandidateFields(client, repo, candidate, { status: 'post_fade' })).rejects.toThrow(/changeCandidateStatus/);
  });
});

describe('setTaskTrack', () => {
  const repo = { owner: 'o', name: 'r' };
  const rules = { tracks: [{ id: 'phot_monitoring', role: 'photometry_lead' }, { id: 'early', per_image: true }] };

  function taskClient(data, labelNames) {
    const issues = {
      get: vi.fn(async () => ({ data: { body: stringifyIssueBody(data, '', 'trigger'), labels: labelNames.map((name) => ({ name })) } })),
      update: vi.fn(async () => ({})),
      addLabels: vi.fn(async () => ({})),
      removeLabel: vi.fn(async () => ({})),
    };
    return { client: { rest: { issues } }, issues };
  }
  const task = { issue: { number: 18, labels: [] }, type: 'trigger' };

  it('files an untracked task into a track: body track+role, track label, returns the updated task', async () => {
    const { client, issues } = taskClient({ cand: 'X', track: null, role: null, facility: 'mpg22' }, ['type:trigger', 'cand:X']);
    const moved = await setTaskTrack(client, repo, task, 'phot_monitoring', rules);
    expect(moved.data).toMatchObject({ track: 'phot_monitoring', role: 'photometry_lead', facility: 'mpg22' });
    expect(parseIssueBody(issues.update.mock.calls[0][0].body).data.track).toBe('phot_monitoring');
    expect(issues.addLabels).toHaveBeenCalledWith(expect.objectContaining({ labels: ['track:phot_monitoring'] }));
    expect(issues.removeLabel).not.toHaveBeenCalled();
    expect(moved.issue.labels.map((l) => l.name)).toEqual(['type:trigger', 'cand:X', 'track:phot_monitoring']);
  });

  it('removes the old track label when moving between tracks, and keeps an existing role', async () => {
    const { client, issues } = taskClient({ cand: 'X', track: 'old', role: 'coordinator' }, ['track:old']);
    const moved = await setTaskTrack(client, repo, task, 'phot_monitoring', rules);
    expect(moved.data.role).toBe('coordinator');
    expect(issues.removeLabel.mock.calls.map(([a]) => a.name)).toEqual(['track:old']);
  });

  it('refuses a per-image track without a target image, and unknown tracks', async () => {
    const { client } = taskClient({ cand: 'X' }, []);
    await expect(setTaskTrack(client, repo, task, 'early', rules)).rejects.toThrow(/target image/);
    await expect(setTaskTrack(client, repo, task, 'nope', rules)).rejects.toThrow(/Unknown track/);
  });
});

describe('buildCandidateIssue roles_override', () => {
  it('writes the roles chosen in the form, and {} when none are chosen', () => {
    const base = { id: 'X', raDeg: 0, decDeg: 0, leads: ['a'], status: 'new_candidate' };
    expect(parseIssueBody(buildCandidateIssue({ ...base, rolesOverride: { photometry_lead: 'shsuyu' } }).body).data.roles_override).toEqual({
      photometry_lead: 'shsuyu',
    });
    expect(parseIssueBody(buildCandidateIssue(base).body).data.roles_override).toEqual({});
  });
});
