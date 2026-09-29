// Everything that reads rules.yaml as "the single source of truth for the
// workflow" (plan §6.1): status lookup, role resolution with the
// candidate-override → group-default → unassigned fallthrough (§4.1), and
// the data the dashboard/candidate page need to build their menus without
// any status hard-coded in the app itself.

/** Look up one status definition by id; undefined if rules.yaml has no such id. */
export function getStatus(rules, statusId) {
  return rules.statuses.find((s) => s.id === statusId);
}

/** Statuses to show on the active dashboard (non-terminal ones). */
export function activeStatuses(rules) {
  return rules.statuses.filter((s) => !s.terminal);
}

/**
 * Menu of status transitions for a candidate currently in `statusId`:
 * the declared transitions first (in rules.yaml order), then "other" so an
 * unanticipated path is never blocked (plan §6.1).
 */
export function transitionsFor(rules, statusId) {
  const status = getStatus(rules, statusId);
  const declared = status?.transitions
    ? Object.entries(status.transitions).map(([id, description]) => ({ id, description }))
    : [];
  const other = rules.statuses
    .map((s) => s.id)
    .filter((id) => id !== statusId && !declared.some((d) => d.id === id));
  return { declared, other };
}

/**
 * True when moving from `fromId` to `toId` goes BACK in the workflow, i.e.
 * the target is listed earlier in rules.yaml's `statuses` (which is kept in
 * workflow order). Used to label such moves "Back to …" in the UI so a
 * return to an earlier phase doesn't read like a different status.
 */
export function isBackwardTransition(rules, fromId, toId) {
  const ids = rules.statuses.map((s) => s.id);
  const from = ids.indexOf(fromId);
  const to = ids.indexOf(toId);
  return from !== -1 && to !== -1 && to < from;
}

/**
 * Resolve who holds a role for one candidate, in the order from plan §4.1:
 * 1. candidate.roles_override[roleId]
 * 2. people.roles[roleId].holder
 * 3. unassigned (candidate leads carry it by default, flagged in the UI)
 *
 * Returns `{ personId, source }` where source is 'override' | 'default' | 'unassigned'.
 */
export function resolveRole(candidate, roleId, peopleData) {
  const override = candidate.roles_override?.[roleId];
  if (override) return { personId: override, source: 'override' };

  const groupDefault = peopleData.roles?.[roleId]?.holder;
  if (groupDefault) return { personId: groupDefault, source: 'default' };

  return { personId: null, source: 'unassigned' };
}

/** Resolve every group-default role name to its current holder for one candidate. */
export function resolveAllRoles(candidate, peopleData) {
  const roleIds = Object.keys(peopleData.roles ?? {});
  return Object.fromEntries(roleIds.map((roleId) => [roleId, resolveRole(candidate, roleId, peopleData)]));
}

export function findPerson(peopleData, personId) {
  return peopleData.people.find((p) => p.id === personId);
}

/** Next-step suggestions for a candidate's current status, straight from rules.yaml. */
export function nextStepsFor(rules, statusId) {
  return getStatus(rules, statusId)?.next_steps ?? [];
}

/** Fields that must be filled before a candidate may enter `statusId` (plan §6.1 `requires`). */
export function requiredFieldsFor(rules, statusId) {
  return getStatus(rules, statusId)?.requires ?? [];
}

export function vocabulary(rules, name) {
  return rules.vocabularies?.[name] ?? [];
}

// ---------------------------------------------------------------------------
// Tracks (plan §6.2): parallel workstreams inside a phase. A track's state is
// always DERIVED from its tasks and the candidate's image_dates — never stored.
// ---------------------------------------------------------------------------

export function getTrack(rules, trackId) {
  return (rules.tracks ?? []).find((t) => t.id === trackId);
}

/** Track definitions expected in a phase, in rules.yaml order; unknown ids are skipped. */
export function tracksForStatus(rules, statusId) {
  return (getStatus(rules, statusId)?.tracks ?? []).map((id) => getTrack(rules, id)).filter(Boolean);
}

/** Tasks (from loadCandidateDetail) belonging to one track. */
export function tasksForTrack(track, tasks) {
  return tasks.filter((t) => t.data?.track === track.id);
}

/** The image every delay is measured from; defaults to A, matching the plan's convention. */
export function referenceImage(candidate) {
  return candidate?.time_delays?.reference_image ?? 'A';
}

/**
 * For a `per_image` track: every trailing (non-reference) image that has a
 * `detected` date, each flagged `targeted` if a task in this track names it.
 * Eligible-but-untargeted is a normal, complete outcome (plan §6.2) — in
 * practice only the second-appearing image is usually targeted.
 */
export function eligibleImages(track, candidate, tasks = []) {
  if (!track?.per_image) return [];
  const ref = referenceImage(candidate);
  const trackTasks = tasksForTrack(track, tasks);
  return Object.entries(candidate?.image_dates ?? {})
    .filter(([image, dates]) => image !== ref && dates?.detected)
    .map(([image, dates]) => ({
      image,
      detected: dates.detected,
      targeted: trackTasks.some((t) => t.data?.image === image),
    }))
    .sort((a, b) => String(a.detected).localeCompare(String(b.detected)));
}

/**
 * 'waiting'     — gated on an event (`starts_on`) that hasn't happened yet
 * 'not_started' — no tasks yet
 * 'active'      — at least one open task
 * 'done'        — has tasks and all are closed (untargeted per-image slots never block this)
 */
export function trackState(track, tasks, candidate) {
  const trackTasks = tasksForTrack(track, tasks);
  if (trackTasks.some((t) => t.issue?.state === 'open')) return 'active';
  if (trackTasks.length > 0) return 'done';
  if (track.starts_on === 'image_detected' && eligibleImages({ ...track, per_image: true }, candidate).length === 0) {
    return 'waiting';
  }
  return 'not_started';
}

/**
 * Instruments the Add-task form should offer for a track, as
 * [{ facility, instrument }]. An explicit `instruments:` list
 * ("<facility>/<instrument>" ids) wins; otherwise filter every instrument
 * by the track's `facilities:` and `modes:` (either may be absent). No
 * filters at all means everything is allowed.
 */
export function trackInstruments(track, facilities) {
  const all = facilities.flatMap((facility) => (facility.instruments ?? []).map((instrument) => ({ facility, instrument })));
  if (track?.instruments?.length) {
    const wanted = new Set(track.instruments);
    return all.filter(({ facility, instrument }) => wanted.has(`${facility.id}/${instrument.id}`));
  }
  return all.filter(
    ({ facility, instrument }) =>
      (!track?.facilities?.length || track.facilities.includes(facility.id)) &&
      (!track?.modes?.length || (instrument.modes ?? []).some((m) => track.modes.includes(m))),
  );
}

/**
 * Predicted arrival of every image not yet detected, from time_delays and
 * image_dates: t_ref = reference image's detected date (else discovery_date),
 * date = t_ref + predicted[X], ± predicted_err[X] days. Returns
 * [{ image, date: 'YYYY-MM-DD', errDays }] sorted by date; [] if no anchor.
 * This is the same arithmetic the Milestone-3 trailing-image alert will use.
 */
export function predictedArrivals(candidate) {
  const td = candidate?.time_delays ?? {};
  const dates = candidate?.image_dates ?? {};
  const anchor = dates[referenceImage(candidate)]?.detected ?? candidate?.discovery_date;
  if (!anchor) return [];
  const t0 = Date.parse(`${String(anchor).slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(t0)) return [];
  return Object.entries(td.predicted ?? {})
    .filter(([image, delay]) => Number.isFinite(Number(delay)) && !dates[image]?.detected)
    .map(([image, delay]) => ({
      image,
      date: new Date(t0 + Number(delay) * 86400000).toISOString().slice(0, 10),
      errDays: td.predicted_err?.[image] ?? null,
    }))
    .sort((a, b) => a.date.localeCompare(b.date));
}
