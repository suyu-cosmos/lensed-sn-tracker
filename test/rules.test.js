// Vitest coverage for the track helpers in rules.js (plan §6.2). Fixtures are
// inline rather than read from ../lensed-sn-data, because CI checks out only
// this repo.

import { describe, it, expect } from 'vitest';
import {
  isBackwardTransition,
  tracksForStatus,
  trackState,
  eligibleImages,
  trackInstruments,
  predictedArrivals,
} from '../src/lib/rules.js';

const rules = {
  statuses: [
    { id: 'lensed_sn', tracks: ['phot_monitoring', 'next_image_early_phase_spec', 'no_such_track'] },
    { id: 'new_candidate' },
  ],
  tracks: [
    { id: 'phot_monitoring', role: 'photometry_lead', modes: ['imaging', 'nir_imaging'] },
    { id: 'next_image_early_phase_spec', starts_on: 'image_detected', per_image: true, instruments: ['vlt/muse'] },
    { id: 'space_followup', facilities: ['hst', 'jwst'] },
  ],
};
const early = rules.tracks[1];
const phot = rules.tracks[0];

const task = (track, state, image = null) => ({ issue: { state }, data: { track, image } });

describe('tracksForStatus', () => {
  it('returns the phase tracks in rules.yaml order and skips unknown ids', () => {
    expect(tracksForStatus(rules, 'lensed_sn').map((t) => t.id)).toEqual(['phot_monitoring', 'next_image_early_phase_spec']);
    expect(tracksForStatus(rules, 'new_candidate')).toEqual([]);
  });
});

describe('eligibleImages', () => {
  const candidate = {
    time_delays: { reference_image: 'A' },
    image_dates: { A: { detected: '2026-09-01' }, C: { detected: '2026-09-20' }, B: { detected: '2026-09-10' }, D: {} },
  };

  it('lists detected trailing images only (not the reference, not undetected), in order', () => {
    expect(eligibleImages(early, candidate).map((e) => e.image)).toEqual(['B', 'C']);
  });

  it('flags an image targeted only when this track has a task for it', () => {
    const tasks = [task('next_image_early_phase_spec', 'open', 'B'), task('phot_monitoring', 'open', 'C')];
    expect(eligibleImages(early, candidate, tasks)).toEqual([
      { image: 'B', detected: '2026-09-10', targeted: true },
      { image: 'C', detected: '2026-09-20', targeted: false },
    ]);
  });

  it('returns [] for a track that is not per_image', () => {
    expect(eligibleImages(phot, candidate)).toEqual([]);
  });
});

describe('trackState', () => {
  const noTrailing = { image_dates: { A: { detected: '2026-09-01' } } };
  const withB = { image_dates: { A: { detected: '2026-09-01' }, B: { detected: '2026-09-10' } } };

  it('is waiting while a starts_on event has not happened', () => {
    expect(trackState(early, [], noTrailing)).toBe('waiting');
  });

  it('is not_started once eligible but nothing added yet', () => {
    expect(trackState(early, [], withB)).toBe('not_started');
    expect(trackState(phot, [], noTrailing)).toBe('not_started');
  });

  it('is active with any open task and done when all are closed', () => {
    expect(trackState(phot, [task('phot_monitoring', 'open'), task('phot_monitoring', 'closed')], withB)).toBe('active');
    expect(trackState(phot, [task('phot_monitoring', 'closed')], withB)).toBe('done');
  });

  it('is done even if some eligible images were never targeted (B only is a complete outcome)', () => {
    const withBC = { image_dates: { ...withB.image_dates, C: { detected: '2026-09-20' } } };
    expect(trackState(early, [task('next_image_early_phase_spec', 'closed', 'B')], withBC)).toBe('done');
  });

  it("ignores other tracks' tasks", () => {
    expect(trackState(phot, [task('spec_monitoring', 'open')], withB)).toBe('not_started');
  });
});

describe('trackInstruments', () => {
  const facilities = [
    { id: 'vlt', instruments: [{ id: 'soxs', modes: ['spectroscopy'] }, { id: 'muse', modes: ['ifu'] }] },
    { id: 'mpg22', instruments: [{ id: 'grond', modes: ['imaging'] }] },
    { id: 'jwst', instruments: [{ id: 'nircam', modes: ['nir_imaging'] }] },
  ];
  const ids = (list) => list.map(({ facility, instrument }) => `${facility.id}/${instrument.id}`);

  it('an explicit instruments list wins', () => {
    expect(ids(trackInstruments(early, facilities))).toEqual(['vlt/muse']);
  });
  it('otherwise filters by modes', () => {
    expect(ids(trackInstruments(phot, facilities))).toEqual(['mpg22/grond', 'jwst/nircam']);
  });
  it('or by facilities', () => {
    expect(ids(trackInstruments(rules.tracks[2], facilities))).toEqual(['jwst/nircam']);
  });
  it('no filters means everything', () => {
    expect(trackInstruments({ id: 'x' }, facilities)).toHaveLength(4);
  });
});

describe('predictedArrivals', () => {
  it('anchors on the reference image detection and skips already-detected images', () => {
    const candidate = {
      discovery_date: '2026-08-30',
      time_delays: { reference_image: 'A', predicted: { B: 9.5, C: 14, D: 31 }, predicted_err: { C: 3 } },
      image_dates: { A: { detected: '2026-09-01' }, B: { detected: '2026-09-10' } },
    };
    expect(predictedArrivals(candidate)).toEqual([
      { image: 'C', date: '2026-09-15', errDays: 3 },
      { image: 'D', date: '2026-10-02', errDays: null },
    ]);
  });

  it('falls back to discovery_date, and returns [] with no anchor', () => {
    expect(predictedArrivals({ discovery_date: '2026-09-01', time_delays: { predicted: { B: 1 } } })).toEqual([
      { image: 'B', date: '2026-09-02', errDays: null },
    ]);
    expect(predictedArrivals({ time_delays: { predicted: { B: 1 } } })).toEqual([]);
  });
});

describe('isBackwardTransition', () => {
  const r = { statuses: [{ id: 'new_candidate' }, { id: 'lensed_sn' }, { id: 'post_fade' }, { id: 'data_complete' }] };
  it('is true only when the target is earlier in rules.yaml order', () => {
    expect(isBackwardTransition(r, 'post_fade', 'lensed_sn')).toBe(true);
    expect(isBackwardTransition(r, 'post_fade', 'new_candidate')).toBe(true);
    expect(isBackwardTransition(r, 'post_fade', 'data_complete')).toBe(false);
    expect(isBackwardTransition(r, 'lensed_sn', 'lensed_sn')).toBe(false);
  });
  it('is false for unknown ids rather than guessing', () => {
    expect(isBackwardTransition(r, 'nope', 'lensed_sn')).toBe(false);
  });
});
