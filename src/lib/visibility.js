// Client-side visibility engine (plan §1: "no server"). Computes, for a
// fixed sky position (a lensed-SN candidate does not move), whether it is
// observable from a given site tonight and over the next `lookahead_nights`
// nights, against the constraints in rules.yaml: Sun altitude, Moon
// separation, and airmass/altitude limit.
//
// Implementation notes:
// - astronomy-engine has no direct "arbitrary fixed RA/Dec" horizon
//   function; the documented way to get precession/nutation/aberration
//   handled for a fixed point on the sky is `DefineStar` into one of its
//   eight scratch star slots, then read it back with `Equator`. We reserve
//   Star1 for this. Because DefineStar is global, mutable state, every
//   sample here is computed synchronously (define → read → done) with no
//   `await` in between, so concurrent candidate computations never race.
// - Airmass uses the plane-parallel secant approximation (airmass =
//   sec(zenith angle)), which is what the plan's `max_airmass` field
//   assumes; it is only meaningful well above the horizon, which is exactly
//   where the altitude/airmass cut keeps us.

import * as Astronomy from 'astronomy-engine';

const TARGET_STAR = Astronomy.Body.Star1;

export function airmassFromAltitude(altitudeDeg) {
  if (altitudeDeg <= 0) return Infinity;
  const zenithRad = ((90 - altitudeDeg) * Math.PI) / 180;
  return 1 / Math.cos(zenithRad);
}

/** Inverse of airmassFromAltitude: the altitude at which secant(z) = airmass. */
export function altitudeForAirmass(airmass) {
  if (!Number.isFinite(airmass) || airmass < 1) return 90;
  const zenithRad = Math.acos(1 / airmass);
  return 90 - (zenithRad * 180) / Math.PI;
}

/** Great-circle separation between two RA/Dec points, all in degrees. */
export function angularSeparationDeg(ra1Deg, dec1Deg, ra2Deg, dec2Deg) {
  const toRad = Math.PI / 180;
  const d1 = dec1Deg * toRad;
  const d2 = dec2Deg * toRad;
  const dra = (ra1Deg - ra2Deg) * toRad;
  let cosSep = Math.sin(d1) * Math.sin(d2) + Math.cos(d1) * Math.cos(d2) * Math.cos(dra);
  cosSep = Math.min(1, Math.max(-1, cosSep));
  return (Math.acos(cosSep) * 180) / Math.PI;
}

export function makeObserver(site) {
  return new Astronomy.Observer(site.latitude, site.longitude, site.elevation_m ?? 0);
}

/** Sample target/Sun/Moon altitude and target-Moon separation at one instant. */
export function sampleInstant(date, observer, raDeg, decDeg) {
  Astronomy.DefineStar(TARGET_STAR, raDeg / 15, decDeg, 1000);
  const targetEq = Astronomy.Equator(TARGET_STAR, date, observer, true, true);
  const targetHor = Astronomy.Horizon(date, observer, targetEq.ra, targetEq.dec, 'normal');

  const sunEq = Astronomy.Equator(Astronomy.Body.Sun, date, observer, true, true);
  const sunHor = Astronomy.Horizon(date, observer, sunEq.ra, sunEq.dec, 'normal');

  const moonEq = Astronomy.Equator(Astronomy.Body.Moon, date, observer, true, true);
  const moonHor = Astronomy.Horizon(date, observer, moonEq.ra, moonEq.dec, 'normal');

  const moonSeparationDeg = angularSeparationDeg(
    targetEq.ra * 15,
    targetEq.dec,
    moonEq.ra * 15,
    moonEq.dec,
  );

  return {
    time: date,
    targetAltitude: targetHor.altitude,
    sunAltitude: sunHor.altitude,
    moonAltitude: moonHor.altitude,
    moonSeparationDeg,
  };
}

/** Approximate UTC instant of local solar noon for a given calendar date + longitude. */
function nightWindowStart(baseDate, longitudeDeg, nightIndex) {
  const localNoonOffsetH = 12 - longitudeDeg / 15; // hours, can be outside [0,24)
  const midnightUtc = Date.UTC(baseDate.getUTCFullYear(), baseDate.getUTCMonth(), baseDate.getUTCDate());
  return new Date(midnightUtc + (nightIndex * 24 + localNoonOffsetH) * 3600 * 1000);
}

function dateKey(date) {
  return date.toISOString().slice(0, 10);
}

/**
 * Compute the visibility window for one night (identified by `nightIndex`
 * nights after `baseDate`) at one facility. Scans a rolling 24h window
 * centred on local solar noon so the full local night is captured in one
 * pass, samples every `sampleMinutes`, and returns the longest contiguous
 * run that satisfies every constraint.
 */
export function nightlyVisibility({
  raDeg,
  decDeg,
  site,
  minAltitudeDeg = 30,
  maxAirmass = 2.0,
  rules = {},
  baseDate = new Date(),
  nightIndex = 0,
  sampleMinutes = 10,
}) {
  const observer = makeObserver(site);
  const visRules = rules.visibility ?? {};
  const sunAltitudeMax = visRules.sun_altitude_max_deg ?? -12;
  const moonSeparationMin = visRules.moon_separation_min_deg ?? 30;
  const minWindowMinutes = visRules.min_window_minutes ?? 30;
  const effectiveMinAltitude = Math.max(minAltitudeDeg, altitudeForAirmass(maxAirmass));

  const start = nightWindowStart(baseDate, site.longitude, nightIndex);
  const totalMinutes = 24 * 60;

  let bestRun = null;
  let currentRun = null;

  for (let m = 0; m <= totalMinutes; m += sampleMinutes) {
    const t = new Date(start.getTime() + m * 60000);
    const s = sampleInstant(t, observer, raDeg, decDeg);
    const airmass = airmassFromAltitude(s.targetAltitude);
    const ok =
      s.sunAltitude <= sunAltitudeMax &&
      s.moonSeparationDeg >= moonSeparationMin &&
      s.targetAltitude >= effectiveMinAltitude;

    if (ok) {
      const sample = { ...s, airmass };
      if (currentRun) currentRun.push(sample);
      else currentRun = [sample];
    } else if (currentRun) {
      if (!bestRun || currentRun.length > bestRun.length) bestRun = currentRun;
      currentRun = null;
    }
  }
  if (currentRun && (!bestRun || currentRun.length > bestRun.length)) bestRun = currentRun;

  if (!bestRun) {
    return {
      night: dateKey(start),
      visible: false,
      windowStart: null,
      windowEnd: null,
      durationMinutes: 0,
      bestAltitudeDeg: null,
      bestAirmass: null,
      minMoonSeparationDeg: null,
    };
  }

  const windowStart = bestRun[0].time;
  const windowEnd = new Date(bestRun[bestRun.length - 1].time.getTime() + sampleMinutes * 60000);
  const durationMinutes = Math.round((windowEnd - windowStart) / 60000);

  return {
    night: dateKey(start),
    visible: durationMinutes >= minWindowMinutes,
    windowStart,
    windowEnd,
    durationMinutes,
    bestAltitudeDeg: Math.max(...bestRun.map((s) => s.targetAltitude)),
    bestAirmass: Math.min(...bestRun.map((s) => s.airmass)),
    minMoonSeparationDeg: Math.min(...bestRun.map((s) => s.moonSeparationDeg)),
  };
}

/** Visibility for every night in `rules.visibility.lookahead_nights` (default 7). */
export function upcomingVisibility({ raDeg, decDeg, site, minAltitudeDeg, maxAirmass, rules, baseDate = new Date() }) {
  const nights = rules?.visibility?.lookahead_nights ?? 7;
  return Array.from({ length: nights }, (_, i) =>
    nightlyVisibility({ raDeg, decDeg, site, minAltitudeDeg, maxAirmass, rules, baseDate, nightIndex: i }),
  );
}

/**
 * Tonight's visibility across every facility, for the dashboard's
 * "visible tonight: N of M" cell.
 */
export function visibilityTonightAcrossFacilities(candidate, facilities, rules) {
  const results = facilities.map((facility) => ({
    facility,
    result: nightlyVisibility({
      raDeg: candidate.ra_deg,
      decDeg: candidate.dec_deg,
      site: facility.site,
      minAltitudeDeg: facility.min_altitude_deg,
      maxAirmass: facility.max_airmass,
      rules,
      nightIndex: 0,
    }),
  }));
  const visibleCount = results.filter((r) => r.result.visible).length;
  return { visibleCount, total: facilities.length, results };
}
