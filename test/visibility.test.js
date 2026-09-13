// Vitest coverage for the visibility engine (plan §9): pure-math checks for
// the angle/airmass helpers plus one geometric sanity check against a
// known value that does not depend on any external ephemeris data — the
// north celestial pole's altitude always equals the observer's latitude.

import { describe, it, expect } from 'vitest';
import {
  angularSeparationDeg,
  airmassFromAltitude,
  altitudeForAirmass,
  sampleInstant,
  makeObserver,
} from '../src/lib/visibility.js';

describe('angularSeparationDeg', () => {
  it('is zero for identical coordinates', () => {
    expect(angularSeparationDeg(180, 20, 180, 20)).toBeCloseTo(0, 6);
  });

  it('is 90 degrees for a right-angle offset on the celestial equator', () => {
    expect(angularSeparationDeg(0, 0, 90, 0)).toBeCloseTo(90, 6);
  });

  it('is 180 degrees for antipodal points', () => {
    expect(angularSeparationDeg(0, 45, 180, -45)).toBeCloseTo(180, 6);
  });
});

describe('airmass <-> altitude (secant approximation)', () => {
  it('airmass is 1 at zenith', () => {
    expect(airmassFromAltitude(90)).toBeCloseTo(1, 6);
  });

  it('airmass is 2 at 30 degrees altitude', () => {
    expect(airmassFromAltitude(30)).toBeCloseTo(2, 3);
  });

  it('altitudeForAirmass round-trips airmassFromAltitude', () => {
    expect(altitudeForAirmass(airmassFromAltitude(45))).toBeCloseTo(45, 3);
  });
});

describe('sampleInstant', () => {
  it('places the north celestial pole at an altitude equal to observer latitude', () => {
    // Dec = +90 is the pole; RA is degenerate there, so any value works.
    // Altitude of the pole = observer latitude, independent of time — a
    // known-value check that needs no external reference ephemeris.
    const observer = makeObserver({ latitude: 52.5, longitude: 0, elevation_m: 0 });
    const sample = sampleInstant(new Date('2026-06-01T00:00:00Z'), observer, 0, 90);
    expect(Math.abs(sample.targetAltitude - 52.5)).toBeLessThan(1);
  });

  it('places an object at the zenith at altitude ~90 when RA/Dec match the local meridian at the observer latitude', () => {
    // At the equator, looking straight up (dec = 0) along the meridian at
    // local sidereal noon puts the target at the zenith. We approximate
    // this by checking that some target near the observer's declination,
    // sampled across a day, reaches a maximum altitude close to 90 - |lat - dec|.
    const observer = makeObserver({ latitude: 0, longitude: 0, elevation_m: 0 });
    const times = Array.from({ length: 48 }, (_, i) => new Date(Date.UTC(2026, 5, 1, 0, i * 30)));
    const maxAlt = Math.max(...times.map((t) => sampleInstant(t, observer, 0, 0).targetAltitude));
    expect(maxAlt).toBeGreaterThan(88);
  });
});
