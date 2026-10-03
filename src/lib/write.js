// Shared "build an issue payload" / "mutate and save" logic for the
// Milestone-2 write features (new candidate, add task, change status).
// This is the only place that knows the title/label conventions from plan
// §5.1/§5.2, so the two pages that create issues (new-candidate.js,
// candidate.js's add-task form) can't drift out of sync with each other or
// with the issue templates in lensed-sn-data.

import { getIssue, updateIssueBody, addLabels, removeLabel, labelName, createComment } from './github.js';
import { parseIssueBody, stringifyIssueBody } from './yaml.js';
import { formatUtc } from './format.js';
import { resolveRole, findPerson, getStatus } from './rules.js';

// Which group-default role gets CC'd on a trigger's PI email, by the
// instrument's observing mode — spectroscopy/IFU triggers go to
// spectroscopy_lead, imaging triggers to photometry_lead. Falls back to
// spectroscopy_lead for any mode not listed (there's no dedicated lead
// role for polarimetry yet).
const LEAD_ROLE_BY_MODE = {
  spectroscopy: 'spectroscopy_lead',
  high_resolution_spectroscopy: 'spectroscopy_lead',
  ifu: 'spectroscopy_lead',
  imaging: 'photometry_lead',
  nir_imaging: 'photometry_lead',
};

export const SN_TYPES = ['unknown', 'Ia', 'II', 'Ibc', 'SLSN', 'other'];
export const LENS_TYPES = ['galaxy', 'group', 'cluster'];
export const TASK_TYPES = ['trigger', 'archival', 'analysis', 'decision'];
// How each task type is named in the app (plan §8 Milestone 2.6). The ids stay
// short because they're also the `type:<id>` labels on GitHub.
export const TASK_TYPE_LABELS = {
  trigger: 'Trigger observation',
  archival: 'Archival observations',
  analysis: 'Analysis',
  decision: 'Decision',
};
export const REDUCTION_STATUSES = ['raw', 'reduced', 'published'];
export const ANALYSIS_PRODUCTS = ['lightcurve', 'spectrum_classification', 'lens_model', 'time_delay'];
// Allowed instrument modes (plan §3); falls back to this list when an
// instrument's own `modes` isn't available for some reason.
export const INSTRUMENT_MODES = [
  'imaging',
  'spectroscopy',
  'ifu',
  'nir_imaging',
  'polarimetry',
  'high_resolution_spectroscopy',
];

/** Build the {title, body, labels} for a brand-new candidate parent issue. */
export function buildCandidateIssue(fields) {
  const data = {
    id: fields.id,
    tns_name: fields.tnsName || null,
    discovery_survey: fields.discoverySurvey || null,
    discovery_date: fields.discoveryDate || null,
    ra_deg: fields.raDeg,
    dec_deg: fields.decDeg,
    lens: {
      name: fields.lensName || null,
      z_lens: fields.zLens ?? null,
      type: fields.lensType || 'galaxy',
      n_images: fields.nImages ?? null,
      image_positions: [],
    },
    source: {
      z_source: fields.zSource ?? null,
      sn_type: fields.snType || 'unknown',
    },
    time_delays: {
      reference_image: 'A',
      predicted: {},
      predicted_err: {},
      measured: {},
      measured_err: {},
    },
    image_dates: {}, // per image { detected, peak, faded } — the event record tracks key off (plan §6.2)
    roles_override: fields.rolesOverride ?? {}, // per-candidate role holders chosen in the form (plan §4.1 level 1)
    status: fields.status,
    false_positive_type: null,
  };

  const title = `[${fields.id}] ${fields.tnsName || 'new candidate'}`;
  const body = stringifyIssueBody(data, '', 'candidate');
  // cand:<id> is also created by lensed-sn-data's label-candidate.yml
  // workflow shortly after this issue appears, but setting it here means
  // the candidate's own sub-issues can be filed immediately without
  // waiting on that Action to run.
  const labels = ['type:candidate', `status:${fields.status}`, `cand:${fields.id}`];

  return { title, body, labels };
}

/**
 * Build the {title, body, labels, assignees} for a new sub-issue under an
 * existing candidate.
 *
 * Track fields (plan §5.2 / §6.2), all optional so untracked tasks still work:
 * `fields.track` (a rules.yaml track id; also added as label `track:<id>`),
 * `fields.image` (per-image tracks), `fields.role` (defaults from the track),
 * plus `cadence_days`/`until` and the `observations` record on triggers.
 *
 * `context` ({ rules, candidate, peopleData, facilities }) is optional: when
 * given, the role defaults from the track and the assignee is resolved from
 * the role via `resolveRole` (so a candidate's roles_override wins, as
 * everywhere else). A trigger is also assigned to the observing program's PI
 * (`resolvePi`), since the PI and the role holder coordinate it together.
 */
export function buildTaskIssue(candidateId, type, fields, context = {}) {
  const { rules, candidate, peopleData, facilities } = context;
  const track = fields.track && rules ? (rules.tracks ?? []).find((t) => t.id === fields.track) : null;
  const role = fields.role || track?.role || null;
  const trackFields = {
    track: fields.track || null,
    image: fields.image || null,
    role,
  };

  let data;
  let titleSuffix;

  switch (type) {
    case 'trigger':
      data = {
        cand: candidateId,
        ...trackFields,
        cadence_days: fields.cadenceDays ?? null, // recurring campaign = ONE issue with a cadence; null = one-off
        until: fields.until || null,
        facility: fields.facility,
        instrument: fields.instrument,
        mode: fields.mode,
        filter: fields.filterBand || null, // only meaningful for single_filter instruments (facilities.yaml), e.g. WFI's R/I
        requested_date: fields.requestedDate || null,
        exposure: fields.exposure || null, // not collected by the app's form on purpose — left for the PI/trigger coordinator (or future automation) to fill in
        images: fields.images,
        pi_contacted: false,
        scheduled_utc: null,
        observations: [], // one entry per night of data taken — appendTriggerObservation (plan §8 M2.6)
      };
      titleSuffix = `trigger: ${fields.facility}/${fields.instrument}`;
      break;
    case 'archival':
      // Data we didn't request (surveys, archives, other groups): the source is
      // free text, not a facilities.yaml id, and there's no PI to involve.
      data = {
        cand: candidateId,
        ...trackFields,
        source: fields.source,
        instrument: fields.instrument || null, // free text: instrument and/or bands
        date_start: fields.dateStart || null, // the data's time coverage
        date_end: fields.dateEnd || null,
        data_location: fields.dataLocation || '',
        reduction_status: fields.reductionStatus || 'raw',
      };
      titleSuffix = `archival: ${fields.source}${fields.instrument ? ` ${fields.instrument}` : ''}`;
      break;
    case 'analysis':
      data = {
        cand: candidateId,
        ...trackFields,
        product: fields.product,
        result: fields.result || '',
        files: fields.files,
      };
      titleSuffix = `analysis: ${fields.product}`;
      break;
    case 'decision':
      data = {
        cand: candidateId,
        ...trackFields,
        deadline: fields.deadline || null,
        options: fields.options,
      };
      titleSuffix = `decision: ${fields.summary || 'pending'}`;
      break;
    default:
      throw new Error(`Unknown task type "${type}"`);
  }

  const imageSuffix = fields.image ? ` (image ${fields.image})` : '';
  const title = `[${candidateId}] ${titleSuffix}${imageSuffix}`;
  const body = stringifyIssueBody(data, '', type);
  const labels = [`type:${type}`, `cand:${candidateId}`];
  if (fields.facility) labels.push(`facility:${fields.facility}`);
  if (fields.track) labels.push(`track:${fields.track}`);

  const roleHolderId = role && peopleData ? resolveRole(candidate ?? {}, role, peopleData).personId : null;
  let piId = null;
  if (type === 'trigger' && facilities) {
    const facility = facilities.find((f) => f.id === fields.facility);
    piId = facility ? resolvePi(facility, facility.instruments?.find((i) => i.id === fields.instrument)) : null;
  }
  const assignees = [...new Set([piId, roleHolderId])].filter(Boolean);

  return { title, body, labels, assignees };
}

/** The program PI for a trigger: an instrument's own `pi:` overrides the facility-level `contact.pi`. */
export function resolvePi(facility, instrument) {
  return instrument?.pi ?? facility?.contact?.pi ?? null;
}

/**
 * A pre-filled `mailto:` link for the "Trigger" step's PI contact (plan
 * §8 Milestone 2): coordinates, a finder-chart link (Aladin Lite, keyed
 * off RA/Dec — no finder-chart generator of our own), and tonight's
 * visibility window at this facility, computed by the caller via
 * `nightlyVisibility` and passed in as `visibilityTonight`.
 */
/**
 * Builds the trigger email's recipients and mailto: URL. The "To" is the
 * program PI — an instrument's own `pi:` overrides the facility-level
 * `contact.pi` (facilities.yaml), since one facility can host more than
 * one program (e.g. vlt's MUSE/FORS2 vs. its facility-level PI). CC is the relevant
 * group-default lead for the instrument's mode (LEAD_ROLE_BY_MODE) plus
 * the main lead, resolved via `resolveRole` so a candidate's own
 * `roles_override` still wins exactly as it would anywhere else in the
 * app. Every address comes from `people.yaml`'s own `email:` field, not a
 * facility-wide placeholder, so it reflects whoever actually holds that
 * role today.
 *
 * Returns `{ url, to, cc }` — `to`/`cc` are resolved people.yaml entries
 * (or null/[] if unresolved), for the caller to describe in its own UI
 * rather than re-deriving the same lookups.
 */
export function buildTriggerMailto({ candidate, facility, instrument, mode, visibilityTonight, peopleData }) {
  const piId = resolvePi(facility, instrument);
  const toPerson = findPerson(peopleData, piId) ?? null;
  const to = toPerson?.email ?? facility.contact?.email ?? '';

  const leadRoleId = LEAD_ROLE_BY_MODE[mode] ?? 'spectroscopy_lead';
  const ccIds = [resolveRole(candidate, leadRoleId, peopleData).personId, resolveRole(candidate, 'main_lead', peopleData).personId];
  const ccPeople = [...new Set(ccIds)] // dedupe (e.g. one person holding both roles)
    .filter((id) => id && id !== piId)
    .map((id) => findPerson(peopleData, id))
    .filter(Boolean);

  const subject = `ToO request: ${candidate.tns_name || candidate.id} — ${facility.name}/${instrument.name}`;
  const finderChartUrl = `https://aladin.cds.unistra.fr/AladinLite/?target=${candidate.ra_deg}%20${candidate.dec_deg}&fov=0.3&survey=P%2FDSS2%2Fcolor`;
  const windowLine = facility.space_based
    ? "Space-based facility — schedule via its own ToO/DDT activation process, not nightly ground visibility."
    : visibilityTonight?.visible
      ? `Visible tonight ${formatUtc(visibilityTonight.windowStart)} – ${formatUtc(visibilityTonight.windowEnd)}, best altitude ${visibilityTonight.bestAltitudeDeg.toFixed(0)}°, airmass ${visibilityTonight.bestAirmass.toFixed(2)}.`
      : 'Not visible tonight from this facility — check the tracker for the next visible night.';

  const bodyText = [
    `Candidate: ${candidate.tns_name || candidate.id} (${candidate.id})`,
    `Coordinates (J2000): RA ${candidate.ra_deg}°, Dec ${candidate.dec_deg}°`,
    `Finder chart: ${finderChartUrl}`,
    windowLine,
    '',
    `Requesting: ${instrument.name} on ${facility.name}`,
  ].join('\n');

  let url = `mailto:${to}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(bodyText)}`;
  if (ccPeople.length) url += `&cc=${encodeURIComponent(ccPeople.map((p) => p.email).filter(Boolean).join(','))}`;

  return { url, to: toPerson, cc: ccPeople };
}

/**
 * Change a candidate's status: re-fetches the issue body fresh (to shrink
 * the race window with an edit made directly on GitHub between page load
 * and this action — not full concurrency control, just a smaller window),
 * mutates `status` (plus any `requires`-listed extra fields), writes the
 * body back, and swaps the `status:*` label to match. This is the one
 * place Milestone 1 left the label and the YAML field able to drift apart.
 */
/**
 * The GitHub issue state a candidate in `statusId` should have: closed for a
 * `terminal` status (as "not planned" if the status says `close_as:
 * not_planned`, e.g. false_positive; else "completed"), open otherwise — so
 * moving back out of a finished status reopens the issue.
 */
export function issueStateFor(rules, statusId) {
  const status = getStatus(rules, statusId);
  if (!status?.terminal) return { state: 'open' };
  return { state: 'closed', state_reason: status.close_as === 'not_planned' ? 'not_planned' : 'completed' };
}

/**
 * Pass `rules` to also open/close the candidate issue to match the new status
 * (issueStateFor), in the same update as the body. When it closes, the
 * status's `close_comment:` (rules.yaml) is posted as a comment — GitHub's
 * close reasons are a fixed set, so that's where the group's own wording goes.
 * Tasks are left alone.
 */
export async function changeCandidateStatus(client, dataRepo, candidate, newStatusId, extraFields = {}, rules = null) {
  const fresh = await getIssue(client, dataRepo, candidate.issue.number);
  const { data, notes } = parseIssueBody(fresh.body);
  if (!data) {
    throw new Error("Could not parse this issue's YAML block; refusing to overwrite it.");
  }

  const oldStatusId = data.status;
  const nextData = { ...data, ...extraFields, status: newStatusId };
  const body = stringifyIssueBody(nextData, notes, 'candidate');

  // Only send a state change when it actually changes (no-op updates of an
  // already-closed issue would otherwise bump its "closed as" reason/time).
  let stateChange = {};
  if (rules) {
    const target = issueStateFor(rules, newStatusId);
    if (target.state !== fresh.state) stateChange = target.state === 'open' ? { state: 'open', state_reason: 'reopened' } : target;
  }
  await updateIssueBody(client, dataRepo, candidate.issue.number, body, stateChange);
  const closeComment = stateChange.state === 'closed' ? getStatus(rules, newStatusId)?.close_comment : null;
  if (closeComment) await createComment(client, dataRepo, candidate.issue.number, closeComment);
  const newLabel = `status:${newStatusId}`;
  await addLabels(client, dataRepo, candidate.issue.number, [newLabel]);

  // Remove EVERY other status:* label, not just the one the body named —
  // removing only `status:<oldStatusId>` let a single stale read leave a
  // second status label behind (seen on a real issue: plan §8 M2.5 Step 1).
  // Union of the labels actually on the issue and the body's old status,
  // so either source being stale is covered.
  const stale = new Set(
    (fresh.labels ?? []).map(labelName).filter((name) => name.startsWith('status:') && name !== newLabel),
  );
  if (oldStatusId && oldStatusId !== newStatusId) stale.add(`status:${oldStatusId}`);
  for (const name of stale) {
    await removeLabel(client, dataRepo, candidate.issue.number, name);
  }

  return nextData;
}

/**
 * Deep-merge `patch` into `base` without mutating either: plain objects merge
 * recursively; arrays, scalars and null in `patch` replace the base value.
 * So `{ image_dates: { B: { detected: '2026-10-01' } } }` sets one date and
 * keeps every other image/field intact.
 */
export function deepMerge(base, patch) {
  const isPlain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
  if (!isPlain(base) || !isPlain(patch)) return patch;
  const out = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    out[key] = isPlain(value) && isPlain(base[key]) ? deepMerge(base[key], value) : value;
  }
  return out;
}

/**
 * Generic candidate-field write (e.g. image_dates, time_delays): fetch the
 * issue fresh, deep-merge `patch` into its YAML data, write the body back,
 * and return the new data. Callers should assign the returned data onto
 * `candidate.data` directly rather than refetching — the same "use the
 * write's own result" rule as changeCandidateStatus (see CLAUDE.md). Status
 * changes must still go through changeCandidateStatus, which also keeps the
 * status:* label in sync; this refuses a patch that touches `status`.
 * Pass `{ replace: ['roles_override'] }` to overwrite a key instead of merging.
 */
export async function updateCandidateFields(client, dataRepo, candidate, patch, { replace = [] } = {}) {
  if (Object.prototype.hasOwnProperty.call(patch, 'status')) {
    throw new Error('Use changeCandidateStatus to change status (it also updates the status label).');
  }
  const fresh = await getIssue(client, dataRepo, candidate.issue.number);
  const { data, notes } = parseIssueBody(fresh.body);
  if (!data) {
    throw new Error("Could not parse this issue's YAML block; refusing to overwrite it.");
  }
  // `replace` lists top-level keys whose patch value replaces the stored one
  // outright instead of deep-merging — needed to *remove* entries, e.g. a
  // role override set back to "Group default" (merging can only add/change).
  const nextData = deepMerge(data, patch);
  for (const key of replace) nextData[key] = patch[key];
  await updateIssueBody(client, dataRepo, candidate.issue.number, stringifyIssueBody(nextData, notes, 'candidate'));
  return nextData;
}

/**
 * Move an existing task into a track (e.g. one filed as untracked by
 * mistake, or created before tracks existed): fetch fresh, set `track`
 * (and `role` from the track if the task has none), add `track:<id>`,
 * remove any other `track:*` label, and return the updated task entry
 * ({ issue, type, data, notes }) for the caller to render directly — the
 * same "use the write's own result" rule as everywhere else (CLAUDE.md).
 * Per-image tracks need a target image; pass `image` or have one already.
 */
export async function setTaskTrack(client, dataRepo, task, trackId, rules, image = null) {
  const track = (rules.tracks ?? []).find((t) => t.id === trackId);
  if (!track) throw new Error(`Unknown track "${trackId}".`);
  const fresh = await getIssue(client, dataRepo, task.issue.number);
  const { data, notes } = parseIssueBody(fresh.body);
  if (!data) throw new Error("Could not parse this issue's YAML block; refusing to overwrite it.");
  const targetImage = image || data.image || null;
  if (track.per_image && !targetImage) throw new Error(`"${track.label ?? track.id}" needs a target image.`);

  const nextData = { ...data, track: trackId, image: targetImage, role: data.role || track.role || null };
  await updateIssueBody(client, dataRepo, task.issue.number, stringifyIssueBody(nextData, notes, task.type));

  const newLabel = `track:${trackId}`;
  await addLabels(client, dataRepo, task.issue.number, [newLabel]);
  const labelNames = (fresh.labels ?? []).map(labelName);
  const stale = labelNames.filter((name) => name.startsWith('track:') && name !== newLabel);
  if (data.track && data.track !== trackId) stale.push(`track:${data.track}`);
  for (const name of new Set(stale)) await removeLabel(client, dataRepo, task.issue.number, name);

  const labels = [...labelNames.filter((n) => !n.startsWith('track:')), newLabel].map((name) => ({ name }));
  return { ...task, issue: { ...task.issue, labels }, data: nextData, notes };
}

/**
 * Log one night of data on a trigger (plan §8 Milestone 2.6): fetch the issue
 * fresh, append `entry` ({ obs_utc, setup, conditions, data_location,
 * reduction_status }) to its `observations` list, save, and return the
 * updated task entry for the caller to render directly (no refetch).
 */
export async function appendTriggerObservation(client, dataRepo, task, entry) {
  const fresh = await getIssue(client, dataRepo, task.issue.number);
  const { data, notes } = parseIssueBody(fresh.body);
  if (!data) throw new Error("Could not parse this issue's YAML block; refusing to overwrite it.");
  const clean = {
    obs_utc: entry.obs_utc || null,
    setup: entry.setup || null,
    conditions: entry.conditions || null,
    data_location: entry.data_location || '',
    reduction_status: entry.reduction_status || 'raw',
  };
  const nextData = { ...data, observations: [...(Array.isArray(data.observations) ? data.observations : []), clean] };
  const body = stringifyIssueBody(nextData, notes, task.type);
  await updateIssueBody(client, dataRepo, task.issue.number, body);
  return { ...task, issue: { ...task.issue, body }, data: nextData, notes };
}
