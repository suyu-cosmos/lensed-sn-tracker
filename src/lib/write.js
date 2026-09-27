// Shared "build an issue payload" / "mutate and save" logic for the
// Milestone-2 write features (new candidate, add task, change status).
// This is the only place that knows the title/label conventions from plan
// §5.1/§5.2, so the two pages that create issues (new-candidate.js,
// candidate.js's add-task form) can't drift out of sync with each other or
// with the issue templates in lensed-sn-data.

import { getIssue, updateIssueBody, addLabels, removeLabel } from './github.js';
import { parseIssueBody, stringifyIssueBody } from './yaml.js';
import { formatUtc } from './format.js';

export const SN_TYPES = ['unknown', 'Ia', 'II', 'Ibc', 'SLSN', 'other'];
export const LENS_TYPES = ['galaxy', 'group', 'cluster'];
export const TASK_TYPES = ['trigger', 'observation', 'analysis', 'decision'];
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
    time_delays: { predicted: {}, measured: {} },
    leads: fields.leads,
    roles_override: {},
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

/** Build the {title, body, labels} for a new sub-issue under an existing candidate. */
export function buildTaskIssue(candidateId, type, fields) {
  let data;
  let titleSuffix;

  switch (type) {
    case 'trigger':
      data = {
        cand: candidateId,
        facility: fields.facility,
        instrument: fields.instrument,
        mode: fields.mode,
        requested_date: fields.requestedDate || null,
        exposure: fields.exposure || null,
        images: fields.images,
        pi_contacted: false,
        scheduled_utc: null,
      };
      titleSuffix = `trigger: ${fields.facility}/${fields.instrument}`;
      break;
    case 'observation':
      data = {
        cand: candidateId,
        facility: fields.facility,
        instrument: fields.instrument,
        obs_utc: fields.obsUtc || null,
        'filters/setup': fields.filtersSetup || null,
        conditions: fields.conditions || null,
        data_location: fields.dataLocation || '',
        reduction_status: fields.reductionStatus || 'raw',
      };
      titleSuffix = `observation: ${fields.facility}/${fields.instrument}`;
      break;
    case 'analysis':
      data = {
        cand: candidateId,
        product: fields.product,
        result: fields.result || '',
        files: fields.files,
      };
      titleSuffix = `analysis: ${fields.product}`;
      break;
    case 'decision':
      data = {
        cand: candidateId,
        deadline: fields.deadline || null,
        options: fields.options,
      };
      titleSuffix = `decision: ${fields.summary || 'pending'}`;
      break;
    default:
      throw new Error(`Unknown task type "${type}"`);
  }

  const title = `[${candidateId}] ${titleSuffix}`;
  const body = stringifyIssueBody(data, '', type);
  const labels = [`type:${type}`, `cand:${candidateId}`];
  if (fields.facility) labels.push(`facility:${fields.facility}`);

  return { title, body, labels };
}

/**
 * A pre-filled `mailto:` link for the "Trigger" step's PI contact (plan
 * §8 Milestone 2): coordinates, a finder-chart link (Aladin Lite, keyed
 * off RA/Dec — no finder-chart generator of our own), and tonight's
 * visibility window at this facility, computed by the caller via
 * `nightlyVisibility` and passed in as `visibilityTonight`.
 */
export function buildTriggerMailto({ candidate, facility, instrument, visibilityTonight }) {
  const to = facility.contact?.email ?? '';
  const subject = `ToO request: ${candidate.tns_name || candidate.id} — ${facility.name}/${instrument.name}`;
  const finderChartUrl = `https://aladin.cds.unistra.fr/AladinLite/?target=${candidate.ra_deg}%20${candidate.dec_deg}&fov=0.3&survey=P%2FDSS2%2Fcolor`;
  const windowLine = visibilityTonight?.visible
    ? `Visible tonight ${formatUtc(visibilityTonight.windowStart)} – ${formatUtc(visibilityTonight.windowEnd)}, best altitude ${visibilityTonight.bestAltitudeDeg.toFixed(0)}°, airmass ${visibilityTonight.bestAirmass.toFixed(2)}.`
    : 'Not visible tonight from this facility — check the tracker for the next visible night.';

  const body = [
    `Candidate: ${candidate.tns_name || candidate.id} (${candidate.id})`,
    `Coordinates (J2000): RA ${candidate.ra_deg}°, Dec ${candidate.dec_deg}°`,
    `Finder chart: ${finderChartUrl}`,
    windowLine,
    '',
    `Requesting: ${instrument.name} on ${facility.name}`,
  ].join('\n');

  return `mailto:${to}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
}

/**
 * Change a candidate's status: re-fetches the issue body fresh (to shrink
 * the race window with an edit made directly on GitHub between page load
 * and this action — not full concurrency control, just a smaller window),
 * mutates `status` (plus any `requires`-listed extra fields), writes the
 * body back, and swaps the `status:*` label to match. This is the one
 * place Milestone 1 left the label and the YAML field able to drift apart.
 */
export async function changeCandidateStatus(client, dataRepo, candidate, newStatusId, extraFields = {}) {
  const fresh = await getIssue(client, dataRepo, candidate.issue.number);
  const { data, notes } = parseIssueBody(fresh.body);
  if (!data) {
    throw new Error("Could not parse this issue's YAML block; refusing to overwrite it.");
  }

  const oldStatusId = data.status;
  const nextData = { ...data, ...extraFields, status: newStatusId };
  const body = stringifyIssueBody(nextData, notes, 'candidate');

  await updateIssueBody(client, dataRepo, candidate.issue.number, body);
  await addLabels(client, dataRepo, candidate.issue.number, [`status:${newStatusId}`]);
  if (oldStatusId && oldStatusId !== newStatusId) {
    await removeLabel(client, dataRepo, candidate.issue.number, `status:${oldStatusId}`);
  }

  return nextData;
}
