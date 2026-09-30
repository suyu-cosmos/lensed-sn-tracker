// Candidate page (plan §8; Milestone 2 writes; Milestone 2.5 tracks): header +
// change status, visibility for tonight + the next `lookahead_nights` nights,
// image timeline, follow-up tracks (plan §6.2) with their tasks, add-task /
// trigger form, observation log, suggested next steps, threaded comments.
//
// Milestone 1 has no charting dependency, so "visibility panel" renders as
// a per-night summary card (window, best altitude/airmass, min Moon
// separation) rather than a plotted altitude curve — the same numbers a
// curve would be read off of.

import { loadCandidateDetail, refreshCandidate, facilityById, buildTaskFromIssue, mergeTasks } from '../lib/data.js';
import {
  getStatus,
  findPerson,
  nextStepsFor,
  transitionsFor,
  isBackwardTransition,
  requiredFieldsFor,
  vocabulary,
  resolveRole,
  tracksForStatus,
  tasksForTrack,
  trackState,
  eligibleImages,
  trackInstruments,
  predictedArrivals,
  referenceImage,
  rolesForStatus,
  newlyRelevantRoles,
  assignablePeople,
} from '../lib/rules.js';
import { nightlyVisibility, upcomingVisibility } from '../lib/visibility.js';
import { createIssue, setIssueAssignees } from '../lib/github.js';
import {
  buildTaskIssue,
  buildTriggerMailto,
  changeCandidateStatus,
  updateCandidateFields,
  setTaskTrack,
  TASK_TYPES,
  REDUCTION_STATUSES,
  ANALYSIS_PRODUCTS,
  INSTRUMENT_MODES,
} from '../lib/write.js';
import { escapeHtml, statusPillHtml, formatUtc, formatMinutes } from '../lib/format.js';

function findCandidate(candidates, routeId) {
  if (routeId.startsWith('issue-')) {
    const number = Number(routeId.slice('issue-'.length));
    return candidates.find((c) => c.issue.number === number);
  }
  return candidates.find((c) => c.data?.id === routeId);
}

function renderNightCard(night) {
  if (!night.visible) {
    return `<div class="night-card"><h3>${night.night}</h3><div class="no-window">not visible</div></div>`;
  }
  return `
    <div class="night-card">
      <h3>${night.night}</h3>
      <div>${formatUtc(night.windowStart)} – ${formatUtc(night.windowEnd)}</div>
      <div class="muted">
        ${formatMinutes(night.durationMinutes)} ·
        alt ${night.bestAltitudeDeg.toFixed(0)}° ·
        airmass ${night.bestAirmass.toFixed(2)} ·
        moon ${night.minMoonSeparationDeg.toFixed(0)}°
      </div>
    </div>`;
}

function renderVisibility(candidateData, facilities, rules) {
  if (!candidateData?.ra_deg && candidateData?.ra_deg !== 0) {
    return '<p class="muted">No coordinates parsed for this candidate.</p>';
  }
  return facilities
    .map((facility) => {
      if (facility.space_based) {
        return `
          <h3>${escapeHtml(facility.name)}</h3>
          <p class="muted">Space-based facility — no ground site, so nightly altitude/airmass visibility doesn't apply. Scheduling follows its own sun-avoidance/roll constraints instead.</p>`;
      }
      const nights = upcomingVisibility({
        raDeg: candidateData.ra_deg,
        decDeg: candidateData.dec_deg,
        site: facility.site,
        minAltitudeDeg: facility.min_altitude_deg,
        maxAirmass: facility.max_airmass,
        rules,
      });
      const cards = nights.map(renderNightCard).join('');
      return `<h3>${escapeHtml(facility.name)}</h3><div class="visibility-grid">${cards}</div>`;
    })
    .join('');
}

function roleLine(data, people, roleId) {
  const { personId, source } = resolveRole(data, roleId, people);
  const name = personId ? findPerson(people, personId)?.name ?? personId : 'unassigned';
  const tag = source === 'default' ? ' <span class="inherited">(group default)</span>' : '';
  const cls = source === 'unassigned' ? 'unassigned' : '';
  return `<li><strong>${escapeHtml(roleId)}:</strong> <span class="${cls}">${escapeHtml(name)}</span>${tag}</li>`;
}

/** Dropdown for one role: "" = group default (writes nothing), else a person id. */
function roleSelect(name, roleId, people, currentOverride) {
  const holderId = people.roles?.[roleId]?.holder;
  const holder = holderId ? findPerson(people, holderId)?.name ?? holderId : 'unassigned';
  const options = assignablePeople(people, currentOverride)
    .map((p) => `<option value="${escapeHtml(p.id)}" ${p.id === currentOverride ? 'selected' : ''}>${escapeHtml(p.name)} (${escapeHtml(p.id)})</option>`)
    .join('');
  return `<select name="${escapeHtml(name)}"><option value="" ${currentOverride ? '' : 'selected'}>Group default (${escapeHtml(holder)})</option>${options}</select>`;
}

/**
 * Roles card: the phase's relevant roles (rules.yaml `roles:`) up front, the
 * rest folded away; "Edit roles" swaps in a form of dropdowns that writes
 * `roles_override` (plan §4.1 level 1). "Group default" removes the pin.
 */
function renderRolesCard(data, rules, people) {
  const all = Object.keys(people.roles ?? {});
  const relevant = rolesForStatus(rules, data.status, people).filter((r) => all.includes(r));
  const others = all.filter((r) => !relevant.includes(r));
  const phase = getStatus(rules, data.status)?.label ?? data.status;
  const overrides = data.roles_override ?? {};
  const editRow = (roleId) => `<label>${escapeHtml(roleId)} ${roleSelect(`roleov:${roleId}`, roleId, people, overrides[roleId])}</label>`;

  return `
    <div class="card" id="roles-card">
      <div class="track-head">
        <h2>Roles <span class="muted">(${escapeHtml(phase)})</span></h2>
        <button type="button" class="linklike" id="edit-roles-btn">Edit roles</button>
      </div>
      <div id="roles-view">
        <ul class="next-steps">${relevant.map((r) => roleLine(data, people, r)).join('')}</ul>
        ${
          others.length
            ? `<details><summary class="muted">Not active in this phase (${others.length})</summary><ul class="next-steps">${others
                .map((r) => roleLine(data, people, r))
                .join('')}</ul></details>`
            : ''
        }
      </div>
      <form id="roles-form" hidden>
        <p class="muted">"Group default" follows people.yaml; choosing a person pins that role for this candidate only.</p>
        ${relevant.map(editRow).join('')}
        ${others.length ? `<details><summary class="muted">Roles not active in this phase</summary>${others.map(editRow).join('')}</details>` : ''}
        <div class="form-actions">
          <button type="submit">Save roles</button>
          <button type="button" class="linklike" id="cancel-roles-btn">Cancel</button>
          <span id="roles-error" class="error"></span>
        </div>
      </form>
    </div>`;
}

/** Read `roleov:<role>` selects from a form into a full roles_override object (base kept for roles not in the form). */
function collectRoleOverrides(form, base = {}) {
  const next = { ...base };
  form.querySelectorAll('select[name^="roleov:"]').forEach((sel) => {
    const roleId = sel.name.slice('roleov:'.length);
    if (sel.value) next[roleId] = sel.value;
    else delete next[roleId];
  });
  return next;
}

/**
 * Task table. `opts.track` adds a Track column (rules needed for labels),
 * `opts.image` adds an Image column (per-image tracks).
 */
function renderTasks(tasks, opts = {}) {
  if (!tasks.length) return '<p class="muted">No tasks yet.</p>';
  // opts.moveTo: tracks a task can be refiled into (per-image tracks need a
  // target image, so they're only offered for tasks that already name one).
  const moveCell = (t) => {
    const choices = (opts.moveTo ?? []).filter((tr) => tr.id !== t.data?.track && (!tr.per_image || t.data?.image));
    if (!t.data || !choices.length) return '<td class="muted">—</td>';
    return `<td class="move-cell"><select data-move-select="${t.issue.number}"><option value="">move to…</option>${optionEls(
      choices.map((tr) => tr.id),
      choices.map((tr) => tr.label ?? tr.id),
    )}</select> <button type="button" class="linklike" data-move-task="${t.issue.number}">Move</button></td>`;
  };
  const trackLabel = (id) => (id ? opts.rules?.tracks?.find((t) => t.id === id)?.label ?? id : '—');
  const rows = tasks
    .map(
      (t) => `
      <tr>
        <td><a href="${t.issue.html_url}" target="_blank" rel="noreferrer">${escapeHtml(t.issue.title)}</a></td>
        <td>${escapeHtml(t.type)}</td>
        ${opts.track ? `<td>${escapeHtml(trackLabel(t.data?.track))}</td>` : ''}
        ${opts.image ? `<td>${escapeHtml(t.data?.image ?? '—')}</td>` : ''}
        <td>${escapeHtml(t.issue.state)}</td>
        <td>${escapeHtml((t.issue.assignees ?? []).map((a) => a.login).join(', ') || '—')}</td>
        ${opts.moveTo ? moveCell(t) : ''}
      </tr>`,
    )
    .join('');
  return `<div class="table-scroll"><table><thead><tr><th>Task</th><th>Type</th>${opts.track ? '<th>Track</th>' : ''}${
    opts.image ? '<th>Image</th>' : ''
  }<th>State</th><th>Assignees</th>${opts.moveTo ? '<th>Move</th>' : ''}</tr></thead><tbody>${rows}</tbody></table></div>`;
}

// ---------- image timeline (plan §5.1 image_dates) ----------

const IMAGE_FIELDS = ['detected', 'peak', 'faded'];

/** Every image label we know of for this candidate, sorted: reference, image_dates, predicted delays, image_positions, n_images. */
function imageLabels(data) {
  const labels = new Set([referenceImage(data)]);
  for (const key of Object.keys(data?.image_dates ?? {})) labels.add(key);
  for (const key of Object.keys(data?.time_delays?.predicted ?? {})) labels.add(key);
  for (const pos of data?.lens?.image_positions ?? []) if (pos?.label) labels.add(String(pos.label));
  const n = Number(data?.lens?.n_images);
  if (Number.isInteger(n) && n > 0 && n <= 26) for (let i = 0; i < n; i++) labels.add(String.fromCharCode(65 + i));
  return [...labels].sort();
}

/** True when there is at least one known image and every known image has a `faded` date. */
function allImagesFaded(data) {
  const images = imageLabels(data);
  return images.length > 0 && images.every((image) => data?.image_dates?.[image]?.faded);
}

function renderImageTimeline(data) {
  const ref = referenceImage(data);
  const arrivals = predictedArrivals(data);
  const byImage = new Map(arrivals.map((a) => [a.image, a]));
  const fmtArrival = (a) => `${a.date}${a.errDays != null ? ` ± ${a.errDays} d` : ''}`;
  const dateInput = (image, field) =>
    `<input type="date" name="${field}:${escapeHtml(image)}" value="${escapeHtml(data?.image_dates?.[image]?.[field] ?? '')}" />`;

  const rows = imageLabels(data)
    .map((image) => {
      const a = byImage.get(image);
      const expected = a ? fmtArrival(a) : image === ref ? 'reference image' : '—';
      return `<tr><td><strong>${escapeHtml(image)}</strong></td>${IMAGE_FIELDS.map((f) => `<td>${dateInput(image, f)}</td>`).join('')}<td class="muted">${escapeHtml(expected)}</td></tr>`;
    })
    .join('');

  const next = arrivals[0];
  const summary = next
    ? `Next image expected: <strong>${escapeHtml(next.image)}</strong> ~${escapeHtml(fmtArrival(next))}`
    : 'No predicted arrivals yet — fill <code>time_delays.predicted</code> (and <code>predicted_err</code>) on the candidate issue to enable this.';

  return `
    <div class="card" id="image-timeline-card">
      <h2>Image timeline</h2>
      <p class="muted">${summary}</p>
      <form id="image-timeline-form">
        <div class="table-scroll">
          <table class="compact">
            <thead><tr><th>Image</th><th>Detected</th><th>Peak</th><th>Faded</th><th>Predicted arrival</th></tr></thead>
            <tbody>
              ${rows}
              <tr>
                <td><input name="newImage" placeholder="add…" maxlength="3" /></td>
                ${IMAGE_FIELDS.map((f) => `<td><input type="date" name="${f}:__new" /></td>`).join('')}
                <td></td>
              </tr>
            </tbody>
          </table>
        </div>
        <div class="form-actions">
          <button type="submit">Save image dates</button>
          <span id="image-timeline-error" class="error"></span>
        </div>
      </form>
    </div>`;
}

// ---------- follow-up tracks (plan §6.2) ----------

// Explicit "no track" choice in the Add-task Track select (vs. not chosen yet).
const UNTRACKED = '__untracked';

const TRACK_STATE_LABEL = { waiting: 'waiting for event', not_started: 'not started', active: 'active', done: 'done' };

function renderTrackCard(track, data, tasks, people) {
  const state = trackState(track, tasks, data);
  const trackTasks = tasksForTrack(track, tasks);
  const owner = track.role ? resolveRole(data, track.role, people) : null;
  const ownerName = owner?.personId ? findPerson(people, owner.personId)?.name ?? owner.personId : 'unassigned';
  const cadence = track.default_cadence_days ? ` · default cadence ${escapeHtml(String(track.default_cadence_days))} d` : '';
  const purposes = (track.purposes ?? []).map((p) => `<li>${escapeHtml(p)}</li>`).join('');

  let imagesHtml = '';
  if (track.per_image) {
    const eligible = eligibleImages(track, data, tasks);
    imagesHtml = eligible.length
      ? `<ul class="image-slots">${eligible
          .map(
            (e) => `<li>Image <strong>${escapeHtml(e.image)}</strong> <span class="muted">(detected ${escapeHtml(e.detected)})</span>: ${
              e.targeted
                ? `<span class="track-state state-done">targeted</span> <span class="muted">(${e.taskCount} task${e.taskCount === 1 ? '' : 's'})</span>`
                : '<span class="muted">not targeted</span>'
            } <button type="button" class="linklike" data-add-task data-track="${escapeHtml(track.id)}" data-image="${escapeHtml(e.image)}">+ Add ${e.targeted ? 'another ' : ''}for image ${escapeHtml(e.image)}</button></li>`,
          )
          .join('')}</ul>`
      : '<p class="muted">Waiting for a trailing image to be detected — record its date in the Image timeline above.</p>';
  }

  return `
    <div class="card track-card">
      <div class="track-head">
        <h3>${escapeHtml(track.label ?? track.id)}</h3>
        <span class="track-state state-${state}">${TRACK_STATE_LABEL[state]}</span>
      </div>
      ${track.optional ? '<p class="muted">Optional — not every candidate needs this track.</p>' : ''}
      <p class="muted">Owner: ${escapeHtml(ownerName)}${track.role ? ` (${escapeHtml(track.role)})` : ''}${cadence}</p>
      ${purposes ? `<ul class="purposes">${purposes}</ul>` : ''}
      ${imagesHtml}
      ${trackTasks.length ? renderTasks(trackTasks, { image: track.per_image }) : '<p class="muted">No tasks yet.</p>'}
      ${track.per_image ? '' : `<button type="button" class="linklike" data-add-task data-track="${escapeHtml(track.id)}">+ Add task to this track</button>`}
    </div>`;
}

/**
 * Track cards for the current phase, then tasks from other phases' tracks
 * (e.g. confirmation triggers once live — filed correctly, just not current),
 * then "Other tasks" (untracked / unknown track, with a "move to…" control).
 * Phases without tracks keep the flat table.
 */
function renderTrackSection(ctx, data, tasks) {
  const tracks = tracksForStatus(ctx.rules, data.status);
  if (!tracks.length) return `<h2>Tasks</h2>${renderTasks(tasks, { track: true, rules: ctx.rules })}`;
  const inPhase = new Set(tracks.map((t) => t.id));
  const knownTrack = new Set((ctx.rules.tracks ?? []).map((t) => t.id));
  const earlier = tasks.filter((t) => t.data?.track && !inPhase.has(t.data.track) && knownTrack.has(t.data.track));
  const other = tasks.filter((t) => !inPhase.has(t.data?.track) && !earlier.includes(t));
  return `
    <h2>Follow-up tracks</h2>
    <div class="track-grid">${tracks.map((track) => renderTrackCard(track, data, tasks, ctx.people)).join('')}</div>
    ${
      earlier.length
        ? `<details class="card"><summary><h3>Tasks from other phases (${earlier.length})</h3></summary><p class="muted">Filed under tracks that belong to another phase (e.g. confirmation triggers).</p>${renderTasks(earlier, { track: true, rules: ctx.rules })}</details>`
        : ''
    }
    ${
      other.length
        ? `<div class="card"><h3>Other tasks</h3><p class="muted">Untracked, or with an unknown track. Use "move to…" to file a task under one of this phase's tracks.</p>${renderTasks(other, { track: true, rules: ctx.rules, moveTo: tracks })}<span id="move-task-error" class="error"></span></div>`
        : ''
    }`;
}

function renderObservationLog(tasks) {
  const observations = tasks.filter((t) => t.type === 'observation');
  if (!observations.length) return '<p class="muted">No observations logged yet.</p>';
  const rows = observations
    .map(
      (t) => `
      <tr>
        <td>${escapeHtml(t.data?.facility ?? '—')}</td>
        <td>${escapeHtml(t.data?.instrument ?? '—')}</td>
        <td>${escapeHtml(t.data?.obs_utc ?? '—')}</td>
        <td>${escapeHtml(t.data?.reduction_status ?? '—')}</td>
      </tr>`,
    )
    .join('');
  return `<table><thead><tr><th>Facility</th><th>Instrument</th><th>Obs. UTC</th><th>Reduction</th></tr></thead><tbody>${rows}</tbody></table>`;
}

function renderComments(comments) {
  if (!comments.length) return '<p class="muted">No comments yet.</p>';
  return comments
    .map(
      (c) => `
      <div class="card">
        <div class="muted">${escapeHtml(c.user?.login)} · ${formatUtc(c.created_at)}</div>
        <div>${escapeHtml(c.body)}</div>
      </div>`,
    )
    .join('');
}

function optionEls(values, labels = values) {
  return values.map((v, i) => `<option value="${escapeHtml(v)}">${escapeHtml(labels[i])}</option>`).join('');
}

function renderChangeStatus(rules, currentStatusId, data) {
  const { declared, other } = transitionsFor(rules, currentStatusId);
  // Hint only — never automatic (plan §8 M2.5 Step 4).
  const fadedHint =
    declared.some((d) => d.id === 'post_fade') && allImagesFaded(data)
      ? `<p class="hint">All images have a faded date — consider moving to <strong>${escapeHtml(getStatus(rules, 'post_fade')?.label ?? 'post_fade')}</strong>.</p>`
      : '';
  // A move to an earlier phase is labelled "↩ Back to …" so it doesn't read
  // like a different status; the text after the dash is the *reason* for the
  // move (it depends on where you're coming from), not part of the name.
  const optionText = (id, reason) => {
    const label = getStatus(rules, id)?.label ?? id;
    const name = isBackwardTransition(rules, currentStatusId, id) ? `↩ Back to ${label}` : label;
    return reason ? `${name} — ${reason}` : name;
  };
  const declaredOptions = declared.map((d) => `<option value="${escapeHtml(d.id)}">${escapeHtml(optionText(d.id, d.description))}</option>`).join('');
  const otherOptions = other.map((id) => `<option value="${escapeHtml(id)}">${escapeHtml(optionText(id))}</option>`).join('');
  return `
    <div class="card" id="change-status-card">
      <h2>Change status</h2>
      ${fadedHint}
      <form id="status-form">
        <label>New status
          <select name="newStatus">
            <option value="">— choose —</option>
            ${declaredOptions ? `<optgroup label="Declared transitions">${declaredOptions}</optgroup>` : ''}
            <optgroup label="Other">${otherOptions}</optgroup>
          </select>
        </label>
        <div id="status-extra-fields"></div>
        <div class="form-actions">
          <button type="submit">Update status</button>
          <span id="status-error" class="error"></span>
        </div>
      </form>
    </div>`;
}

function renderAddTask(facilities, tracks) {
  const facilityOptions = optionEls(
    facilities.map((f) => f.id),
    facilities.map((f) => f.name),
  );
  const trackSelect = tracks.length
    ? `<label>Track
          <select name="track">
            <option value="" selected>— choose a track —</option>
            ${optionEls(
              tracks.map((t) => t.id),
              tracks.map((t) => t.label ?? t.id),
            )}
            <option value="${UNTRACKED}">Other (untracked)</option>
          </select>
        </label>
        <label data-role="image-wrap" hidden>Target image <select name="image"></select></label>
        <p class="muted" data-role="track-hint"></p>`
    : '';
  return `
    <div class="card" id="add-task-card">
      <h2>Add task</h2>
      <form id="add-task-form">
        ${trackSelect}
        <label>Type
          <select name="type">${optionEls(TASK_TYPES)}</select>
        </label>

        <fieldset data-type="trigger">
          <label>Facility <select name="facility" data-role="facility">${facilityOptions}</select></label>
          <label>Instrument <select name="instrument" data-role="instrument"></select></label>
          <label>Mode <select name="mode" data-role="mode"></select></label>
          <label data-role="filter-wrap" hidden>Wavelength band <select name="filterBand" data-role="filter"></select></label>
          <label>Requested date <input name="requestedDate" type="date" /></label>
          <label>Cadence (days; blank = one-off) <input name="cadenceDays" type="number" min="0" step="any" /></label>
          <label>Until (end of a recurring campaign) <input name="until" type="date" /></label>
          <label data-role="images-wrap">Images <input name="images" placeholder="A, B" /></label>
        </fieldset>

        <fieldset data-type="observation" hidden>
          <label>Facility <select name="facility2" data-role="facility">${facilityOptions}</select></label>
          <label>Instrument <select name="instrument2" data-role="instrument"></select></label>
          <label>Obs. UTC <input name="obsUtc" type="datetime-local" /></label>
          <label>Filters/setup <input name="filtersSetup" /></label>
          <label>Conditions <input name="conditions" /></label>
          <label>Data location <input name="dataLocation" /></label>
          <label>Reduction status <select name="reductionStatus">${optionEls(REDUCTION_STATUSES)}</select></label>
        </fieldset>

        <fieldset data-type="analysis" hidden>
          <label>Product <select name="product">${optionEls(ANALYSIS_PRODUCTS)}</select></label>
          <label>Result <textarea name="result" rows="2"></textarea></label>
          <label>Files <input name="files" placeholder="comma-separated paths/links" /></label>
        </fieldset>

        <fieldset data-type="decision" hidden>
          <label>Summary (used in the title) <input name="summary" placeholder="which facility to trigger?" /></label>
          <label>Deadline <input name="deadline" type="date" /></label>
          <label>Options <input name="options" placeholder="comma-separated" /></label>
        </fieldset>

        <div class="form-actions">
          <button type="submit">Create task</button>
          <span id="add-task-error" class="error"></span>
        </div>
      </form>
      <div id="trigger-mailto"></div>
    </div>`;
}

/**
 * Wire up the facility -> instrument -> mode(+filter, +images) cascade for
 * one group of selects. Optional pieces:
 * - `filterSelect`/`filterWrap`: a "Wavelength band" picker, shown only for
 *   instruments marked `single_filter: true` (facilities.yaml) — one filter
 *   per exposure, unlike a simultaneous multi-band imager like GROND.
 * - `imagesWrap`: "which lensed image(s)", shown only for a narrow aperture
 *   (long-slit spectroscopy, or JWST's small-FOV NIRSpec IFU); imaging and a
 *   wide-field IFU like MUSE cover the whole lens system. Hidden = cleared.
 * - `allowed()`: returns the current track (or null). When set, facilities,
 *   instruments and modes are restricted via `trackInstruments` and the
 *   track's `modes:` (plan §6.2 — instruments are data, not code).
 * Returns `{ refresh }` so the caller can re-apply after the track changes.
 */
function wireFacilityCascade({ facilities, facilitySelect, instrumentSelect, modeSelect, filterSelect, filterWrap, imagesWrap, allowed }) {
  const allowedPairs = () => {
    const track = allowed?.();
    return track ? new Set(trackInstruments(track, facilities).map(({ facility, instrument }) => `${facility.id}/${instrument.id}`)) : null;
  };
  function currentInstrument() {
    const facility = facilityById(facilities, facilitySelect.value);
    return facility?.instruments?.find((i) => i.id === instrumentSelect.value);
  }
  function updateFacilities() {
    const pairs = allowedPairs();
    const usable = pairs ? facilities.filter((f) => (f.instruments ?? []).some((i) => pairs.has(`${f.id}/${i.id}`))) : facilities;
    const previous = facilitySelect.value;
    facilitySelect.innerHTML = optionEls(
      usable.map((f) => f.id),
      usable.map((f) => f.name),
    );
    if (usable.some((f) => f.id === previous)) facilitySelect.value = previous;
    updateInstruments();
  }
  function updateInstruments() {
    const pairs = allowedPairs();
    const facility = facilityById(facilities, facilitySelect.value);
    const instruments = (facility?.instruments ?? []).filter((i) => !pairs || pairs.has(`${facility.id}/${i.id}`));
    instrumentSelect.innerHTML = optionEls(
      instruments.map((i) => i.id),
      instruments.map((i) => i.name),
    );
    if (modeSelect) updateModes();
    if (filterSelect) updateFilter();
  }
  function updateModes() {
    const instrument = currentInstrument();
    const trackModes = allowed?.()?.modes;
    let modes = instrument?.modes?.length ? instrument.modes : INSTRUMENT_MODES;
    if (trackModes?.length && modes.some((m) => trackModes.includes(m))) modes = modes.filter((m) => trackModes.includes(m));
    modeSelect.innerHTML = optionEls(modes);
    if (imagesWrap) updateImages();
  }
  function updateImages() {
    const show = modeSelect.value === 'spectroscopy' || (facilitySelect.value === 'jwst' && modeSelect.value === 'ifu');
    imagesWrap.hidden = !show;
    if (!show) imagesWrap.querySelector('input').value = '';
  }
  function updateFilter() {
    const instrument = currentInstrument();
    const show = Boolean(instrument?.single_filter && instrument.filters?.length);
    filterWrap.hidden = !show;
    filterSelect.innerHTML = show ? optionEls(instrument.filters) : '';
  }
  facilitySelect.addEventListener('change', updateInstruments);
  instrumentSelect.addEventListener('change', () => {
    if (modeSelect) updateModes();
    if (filterSelect) updateFilter();
  });
  if (modeSelect && imagesWrap) modeSelect.addEventListener('change', updateImages);
  updateFacilities();
  return { refresh: updateFacilities };
}

function wireChangeStatusForm(container, ctx, candidate, rules, knownTasks) {
  const form = container.querySelector('#status-form');
  if (!form) return;
  const select = form.querySelector('select[name="newStatus"]');
  const extra = form.querySelector('#status-extra-fields');
  const errorEl = form.querySelector('#status-error');

  select.addEventListener('change', () => {
    const requires = requiredFieldsFor(rules, select.value);
    const requiredHtml = requires
      .map((field) => {
        const vocab = vocabulary(rules, field);
        if (vocab.length) {
          return `<label>${escapeHtml(field)} <select name="extra:${field}">${vocab.map((v) => `<option value="${escapeHtml(v.id)}">${escapeHtml(v.label)}</option>`).join('')}</select></label>`;
        }
        return `<label>${escapeHtml(field)} <input name="extra:${field}" required /></label>`;
      })
      .join('');
    // Roles that become relevant in the target phase (rules.yaml `roles:`) —
    // e.g. lens_modeling_lead + data_manager on confirmation — can be set in
    // the same action. Optional: leaving "Group default" keeps people.yaml's.
    const newRoles = select.value ? newlyRelevantRoles(rules, candidate.data.status, select.value, ctx.people) : [];
    const overrides = candidate.data.roles_override ?? {};
    const rolesHtml = newRoles.length
      ? `<fieldset class="phase-roles"><legend>Roles now relevant in ${escapeHtml(getStatus(rules, select.value)?.label ?? select.value)} <span class="muted">(optional)</span></legend>${newRoles
          .map((roleId) => `<label>${escapeHtml(roleId)} ${roleSelect(`roleov:${roleId}`, roleId, ctx.people, overrides[roleId])}</label>`)
          .join('')}</fieldset>`
      : '';
    extra.innerHTML = requiredHtml + rolesHtml;
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    errorEl.textContent = '';
    const newStatusId = select.value;
    if (!newStatusId) {
      errorEl.textContent = 'Choose a status.';
      return;
    }
    const values = Object.fromEntries(new FormData(form).entries());
    const extraFields = {};
    for (const [key, value] of Object.entries(values)) {
      if (key.startsWith('extra:')) extraFields[key.slice('extra:'.length)] = value;
    }
    // Role choices from the "now relevant" prompt ride along in the same
    // write: changeCandidateStatus merges extra fields flat, so this full
    // object replaces roles_override (a "Group default" choice removes a pin).
    if (form.querySelector('select[name^="roleov:"]')) {
      extraFields.roles_override = collectRoleOverrides(form, candidate.data.roles_override ?? {});
    }

    const submitBtn = form.querySelector('button[type="submit"]');
    submitBtn.disabled = true;
    try {
      // changeCandidateStatus already returns the fully-updated data —
      // patch it into `candidate` directly (same object reference inside
      // ctx.candidates) rather than trusting an immediate refreshCandidates
      // to reflect a write we just made: its listCandidateIssues call has
      // the same label-filtered-list propagation lag we already hit for
      // new-candidate and add-task, so it could just as easily hand back
      // the pre-change body and make the update look like it "did nothing".
      const nextData = await changeCandidateStatus(ctx.client, ctx.config.dataRepo, candidate, newStatusId, extraFields);
      candidate.data = nextData;
      const { tasks, comments } = await loadCandidateDetail(ctx.client, candidate);
      renderCandidatePage(container, ctx, candidate, mergeTasks(tasks, knownTasks), comments);
    } catch (err) {
      errorEl.textContent = `Could not update status: ${err.message}`;
      submitBtn.disabled = false;
    }
  });
}

function wireAddTaskForm(container, ctx, candidate, facilities, tasks, comments) {
  const form = container.querySelector('#add-task-form');
  if (!form) return;
  const typeSelect = form.querySelector('select[name="type"]');
  const trackSelect = form.querySelector('select[name="track"]');
  const imageSelect = form.querySelector('select[name="image"]');
  const imageWrap = form.querySelector('[data-role="image-wrap"]');
  const trackHint = form.querySelector('[data-role="track-hint"]');
  const cadenceInput = form.querySelector('input[name="cadenceDays"]');
  const errorEl = form.querySelector('#add-task-error');
  const mailtoEl = container.querySelector('#trigger-mailto');

  const currentTrack = () =>
    trackSelect?.value && trackSelect.value !== UNTRACKED ? ctx.rules.tracks?.find((t) => t.id === trackSelect.value) ?? null : null;

  const triggerCascade = wireFacilityCascade({
    facilities,
    facilitySelect: form.querySelector('fieldset[data-type="trigger"] [data-role="facility"]'),
    instrumentSelect: form.querySelector('fieldset[data-type="trigger"] [data-role="instrument"]'),
    modeSelect: form.querySelector('fieldset[data-type="trigger"] [data-role="mode"]'),
    filterSelect: form.querySelector('fieldset[data-type="trigger"] [data-role="filter"]'),
    filterWrap: form.querySelector('fieldset[data-type="trigger"] [data-role="filter-wrap"]'),
    imagesWrap: form.querySelector('fieldset[data-type="trigger"] [data-role="images-wrap"]'),
    allowed: currentTrack,
  });
  const observationCascade = wireFacilityCascade({
    facilities,
    facilitySelect: form.querySelector('fieldset[data-type="observation"] [data-role="facility"]'),
    instrumentSelect: form.querySelector('fieldset[data-type="observation"] [data-role="instrument"]'),
    allowed: currentTrack,
  });

  function showType(type) {
    typeSelect.value = type;
    form.querySelectorAll('fieldset[data-type]').forEach((fs) => {
      fs.hidden = fs.dataset.type !== type;
    });
  }
  typeSelect.addEventListener('change', () => {
    showType(typeSelect.value);
    mailtoEl.innerHTML = '';
  });

  // Choosing a track pre-fills type, cadence, the instrument choices and (via
  // its role) the assignee, and asks for the target image on per-image tracks.
  function applyTrack(preselectImage) {
    const track = currentTrack();
    if (track?.task_type) showType(track.task_type);
    if (cadenceInput) cadenceInput.value = track?.default_cadence_days ?? '';
    triggerCascade.refresh();
    observationCascade.refresh();

    if (imageWrap) {
      const eligible = track?.per_image ? eligibleImages(track, candidate.data, tasks) : [];
      imageWrap.hidden = !track?.per_image;
      imageSelect.innerHTML = eligible.length
        ? optionEls(
            eligible.map((e) => e.image),
            eligible.map((e) => `${e.image} (detected ${e.detected})${e.targeted ? ` — ${e.taskCount} task${e.taskCount === 1 ? '' : 's'} so far` : ''}`),
          )
        : '<option value="">no trailing image detected yet</option>';
      if (preselectImage) imageSelect.value = preselectImage;
    }
    if (trackHint) {
      if (!track?.role) {
        trackHint.textContent = !trackSelect.value
          ? 'Choose the follow-up track this task belongs to (or "Other (untracked)").'
          : track
            ? ''
            : 'Untracked task — it will be listed under "Other tasks", with no default owner.';
      } else {
        const { personId } = resolveRole(candidate.data, track.role, ctx.people);
        const name = personId ? findPerson(ctx.people, personId)?.name ?? personId : 'nobody (role unassigned)';
        trackHint.textContent =
          track.task_type === 'trigger'
            ? `Will be assigned to the chosen facility's PI and ${name} (${track.role}).`
            : `Will be assigned to ${name} (${track.role}).`;
      }
    }
  }
  if (trackSelect) {
    trackSelect.addEventListener('change', () => applyTrack());
    applyTrack();
  }

  // "+ Add task to this track" / "+ Add for image X" buttons on the track cards.
  container.querySelectorAll('[data-add-task]').forEach((btn) => {
    btn.addEventListener('click', () => {
      if (!trackSelect) return;
      trackSelect.value = btn.dataset.track;
      applyTrack(btn.dataset.image);
      form.scrollIntoView?.({ behavior: 'smooth', block: 'start' });
    });
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    errorEl.textContent = '';
    mailtoEl.innerHTML = '';

    const type = typeSelect.value;
    const values = Object.fromEntries(new FormData(form).entries());
    const candidateId = candidate.data.id;
    if (trackSelect && !trackSelect.value) {
      errorEl.textContent = 'Choose a track first (or "Other (untracked)").';
      return;
    }
    const track = currentTrack();
    const image = track?.per_image ? values.image || null : null;
    if (track?.per_image && !image) {
      errorEl.textContent = 'Choose which trailing image this task targets (record its detection in the Image timeline first).';
      return;
    }
    const trackFields = { track: track?.id ?? null, image };

    const typeFields =
      type === 'trigger'
        ? {
            facility: values.facility,
            instrument: values.instrument,
            mode: values.mode,
            filterBand: values.filterBand || null,
            requestedDate: values.requestedDate,
            cadenceDays: values.cadenceDays === '' || values.cadenceDays == null ? null : Number(values.cadenceDays),
            until: values.until || null,
            images: (values.images ?? '').split(',').map((s) => s.trim()).filter(Boolean),
          }
        : type === 'observation'
          ? {
              facility: values.facility2,
              instrument: values.instrument2,
              obsUtc: values.obsUtc,
              filtersSetup: values.filtersSetup,
              conditions: values.conditions,
              dataLocation: values.dataLocation,
              reductionStatus: values.reductionStatus,
            }
          : type === 'analysis'
            ? {
                product: values.product,
                result: values.result,
                files: values.files.split(',').map((s) => s.trim()).filter(Boolean),
              }
            : {
                summary: values.summary,
                deadline: values.deadline,
                options: values.options.split(',').map((s) => s.trim()).filter(Boolean),
              };
    const fields = { ...trackFields, ...typeFields };
    // A per-image trigger covers its target image unless told otherwise.
    if (type === 'trigger' && image && !fields.images.length) fields.images = [image];

    const submitBtn = form.querySelector('button[type="submit"]');
    submitBtn.disabled = true;
    try {
      const { title, body, labels, assignees } = buildTaskIssue(candidateId, type, fields, {
        rules: ctx.rules,
        candidate: candidate.data,
        peopleData: ctx.people,
        facilities,
      });
      const issue = await createIssue(ctx.client, ctx.config.dataRepo, { title, body, labels, assignees });

      // Build the banner HTML now but only inject it into the DOM *after*
      // re-rendering below (into the fresh #trigger-mailto element) —
      // otherwise it would be wiped out the instant it appeared.
      let bannerHtml = '';
      if (type === 'trigger') {
        const facility = facilityById(facilities, fields.facility);
        const instrument = facility?.instruments?.find((i) => i.id === fields.instrument);
        const visibilityTonight =
          facility && !facility.space_based
            ? nightlyVisibility({
                raDeg: candidate.data.ra_deg,
                decDeg: candidate.data.dec_deg,
                site: facility.site,
                minAltitudeDeg: facility.min_altitude_deg,
                maxAirmass: facility.max_airmass,
                rules: ctx.rules,
              })
            : null;
        const { url: mailtoUrl, to, cc } = buildTriggerMailto({
          candidate: candidate.data,
          facility,
          instrument,
          mode: fields.mode,
          visibilityTonight,
          peopleData: ctx.people,
        });
        const toName = escapeHtml(to?.name ?? facility?.contact?.pi ?? 'the PI');
        const ccText = cc.length ? ` (cc: ${cc.map((p) => escapeHtml(p.name)).join(', ')})` : '';
        bannerHtml = `<p class="card">Created <a href="${issue.html_url}" target="_blank" rel="noreferrer">#${issue.number}</a>. <a href="${mailtoUrl}">✉️ Email ${toName}${ccText} about this trigger</a></p>`;
      }
      const dropped = issue.droppedAssignees ?? [];
      if (dropped.length || (issue.assignees ?? []).length === 0) {
        const names = dropped.map((id) => `${findPerson(ctx.people, id)?.name ?? id} (${id})`).join(' and ');
        const unassigned = (issue.assignees ?? []).length === 0;
        const reminder = dropped.length
          ? `Task created, but GitHub wouldn't assign ${names} — only collaborators on the data repo can be assigned (a placeholder GitHub username in people.yaml can't). ${unassigned ? 'Please assign someone by hand' : 'Please add them by hand once they have access'}${type === 'trigger' ? ' and email the PI (above)' : ''}.`
          : type === 'trigger'
            ? 'No assignee is set on this task — please email the PI (above) and assign someone responsible for the follow-up.'
            : "No assignee is set on this task yet — consider assigning someone so it doesn't get lost.";
        bannerHtml += `<p class="card unassigned">⚠️ ${escapeHtml(reminder)}</p>`;
      }

      // loadCandidateDetail's label-filtered list lags behind recent creates
      // (see CLAUDE.md) and can omit this task *and* one added a minute ago —
      // merge the refetch with every task this page already knew about.
      const fresh = await loadCandidateDetail(ctx.client, candidate);
      const merged = mergeTasks(fresh.tasks, [buildTaskFromIssue(issue), ...tasks]);
      renderCandidatePage(container, ctx, candidate, merged, fresh.comments);
      if (bannerHtml) {
        const freshMailtoEl = container.querySelector('#trigger-mailto');
        if (freshMailtoEl) freshMailtoEl.innerHTML = bannerHtml;
      }
    } catch (err) {
      errorEl.textContent = `Could not create task: ${err.message}`;
      submitBtn.disabled = false;
    }
  });
}

function wireRolesForm(container, ctx, candidate, tasks, comments) {
  const form = container.querySelector('#roles-form');
  if (!form) return;
  const view = container.querySelector('#roles-view');
  const editBtn = container.querySelector('#edit-roles-btn');
  const errorEl = form.querySelector('#roles-error');
  const setEditing = (on) => {
    form.hidden = !on;
    view.hidden = on;
    editBtn.hidden = on;
  };
  editBtn.addEventListener('click', () => setEditing(true));
  form.querySelector('#cancel-roles-btn').addEventListener('click', () => setEditing(false));

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    errorEl.textContent = '';
    const current = candidate.data.roles_override ?? {};
    const next = collectRoleOverrides(form, current);
    if (JSON.stringify(next) === JSON.stringify(current)) {
      setEditing(false);
      return;
    }
    const submitBtn = form.querySelector('button[type="submit"]');
    submitBtn.disabled = true;
    try {
      const mainLeadBefore = resolveRole(candidate.data, 'main_lead', ctx.people).personId;
      // `replace` so a role set back to "Group default" is actually removed.
      candidate.data = await updateCandidateFields(ctx.client, ctx.config.dataRepo, candidate, { roles_override: next }, { replace: ['roles_override'] });
      // The main lead is the candidate issue's GitHub assignee — keep it in sync.
      const mainLeadAfter = resolveRole(candidate.data, 'main_lead', ctx.people).personId;
      let notice = '';
      if (mainLeadAfter !== mainLeadBefore) {
        const { dropped } = await setIssueAssignees(ctx.client, ctx.config.dataRepo, candidate.issue.number, mainLeadAfter ? [mainLeadAfter] : []);
        if (dropped.length) {
          notice = `Roles saved, but GitHub wouldn't assign ${escapeHtml(findPerson(ctx.people, dropped[0])?.name ?? dropped[0])} (${escapeHtml(dropped[0])}) to the candidate issue — only collaborators on the data repo can be assigned (a placeholder username can't).`;
        }
      }
      renderCandidatePage(container, ctx, candidate, tasks, comments);
      if (notice) container.querySelector('#roles-view')?.insertAdjacentHTML('afterbegin', `<p class="card unassigned">⚠️ ${notice}</p>`);
    } catch (err) {
      errorEl.textContent = `Could not save roles: ${err.message}`;
      submitBtn.disabled = false;
    }
  });
}

function wireMoveToTrack(container, ctx, candidate, tasks, comments) {
  const errorEl = container.querySelector('#move-task-error');
  container.querySelectorAll('[data-move-task]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const number = Number(btn.dataset.moveTask);
      const trackId = container.querySelector(`[data-move-select="${number}"]`)?.value;
      if (!trackId) {
        if (errorEl) errorEl.textContent = 'Pick a track to move the task into.';
        return;
      }
      const task = tasks.find((t) => t.issue.number === number);
      btn.disabled = true;
      try {
        const moved = await setTaskTrack(ctx.client, ctx.config.dataRepo, task, trackId, ctx.rules);
        // Use the write's own result rather than refetching (CLAUDE.md).
        const nextTasks = tasks.map((t) => (t.issue.number === number ? moved : t));
        renderCandidatePage(container, ctx, candidate, nextTasks, comments);
      } catch (err) {
        if (errorEl) errorEl.textContent = `Could not move #${number}: ${err.message}`;
        btn.disabled = false;
      }
    });
  });
}

function wireImageTimelineForm(container, ctx, candidate, tasks, comments) {
  const form = container.querySelector('#image-timeline-form');
  if (!form) return;
  const errorEl = form.querySelector('#image-timeline-error');

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    errorEl.textContent = '';
    const values = Object.fromEntries(new FormData(form).entries());
    const current = candidate.data.image_dates ?? {};
    const patch = {};
    const setField = (image, field, raw) => {
      const value = raw || null;
      if ((current[image]?.[field] ?? null) !== value) {
        patch[image] = { ...(patch[image] ?? {}), [field]: value };
      }
    };

    for (const image of imageLabels(candidate.data)) {
      for (const field of IMAGE_FIELDS) setField(image, field, values[`${field}:${image}`]);
    }
    const newImage = (values.newImage ?? '').trim().toUpperCase();
    if (newImage) {
      if (!/^[A-Z][A-Z0-9]{0,2}$/.test(newImage)) {
        errorEl.textContent = 'New image label should be a letter, optionally followed by up to two letters/digits (e.g. E, A2).';
        return;
      }
      if (imageLabels(candidate.data).includes(newImage)) {
        errorEl.textContent = `Image ${newImage} is already listed — edit its row instead.`;
        return;
      }
      patch[newImage] = { detected: null, peak: null, faded: null };
      for (const field of IMAGE_FIELDS) patch[newImage][field] = values[`${field}:__new`] || null;
    }

    if (!Object.keys(patch).length) {
      errorEl.textContent = 'Nothing changed.';
      return;
    }

    const submitBtn = form.querySelector('button[type="submit"]');
    submitBtn.disabled = true;
    try {
      // Use the write's own result rather than refetching (CLAUDE.md).
      candidate.data = await updateCandidateFields(ctx.client, ctx.config.dataRepo, candidate, { image_dates: patch });
      renderCandidatePage(container, ctx, candidate, tasks, comments);
    } catch (err) {
      errorEl.textContent = `Could not save image dates: ${err.message}`;
      submitBtn.disabled = false;
    }
  });
}

// Only one candidate page is on screen at a time; its "refresh when the tab
// becomes visible again" listener is replaced on every render().
let onVisible = null;

function markDirty(event) {
  event.currentTarget.dataset.dirty = '1';
}

export async function render(container, ctx, params) {
  const { candidates, client } = ctx;
  const candidate = findCandidate(candidates, params.id);

  if (onVisible) document.removeEventListener('visibilitychange', onVisible);
  onVisible = null;

  if (!candidate) {
    container.innerHTML = `<p class="error">No candidate found for "${escapeHtml(params.id)}".</p>`;
    return;
  }

  container.innerHTML = '<p class="muted">Loading candidate…</p>';
  const { tasks, comments } = await loadCandidateDetail(client, candidate);
  renderCandidatePage(container, ctx, candidate, tasks, comments);

  // Coming back to this tab (e.g. after closing a task on GitHub) re-reads
  // GitHub — unless the user has started filling in a form here, which a
  // re-render would wipe; then the ↻ Refresh button is the way.
  const hash = window.location.hash;
  onVisible = () => {
    if (document.visibilityState !== 'visible' || window.location.hash !== hash || !container.isConnected) return;
    if (container.dataset.dirty === '1') return;
    refreshCandidatePage(container, ctx, candidate);
  };
  document.addEventListener('visibilitychange', onVisible);
}

/** Re-read the candidate issue, its tasks and comments from GitHub and re-render. */
async function refreshCandidatePage(container, ctx, candidate) {
  const button = container.querySelector('#refresh-candidate');
  if (button) {
    button.disabled = true;
    button.textContent = '↻ Refreshing…';
  }
  try {
    await refreshCandidate(ctx.client, candidate);
    const { tasks, comments } = await loadCandidateDetail(ctx.client, candidate);
    renderCandidatePage(container, ctx, candidate, tasks, comments);
  } catch (err) {
    if (button) {
      button.disabled = false;
      button.textContent = '↻ Refresh';
    }
    container.querySelector('#refresh-error')?.replaceChildren(`Could not refresh: ${err.message}`);
  }
}

/**
 * The actual DOM build + wiring, split out from `render()` so a caller
 * that already knows the full task list (e.g. wireAddTaskForm, right
 * after creating one) can render it directly instead of going through
 * another `loadCandidateDetail` — see the race-condition note on
 * `listCandidateSubIssues` where this is called.
 */
function renderCandidatePage(container, ctx, candidate, tasks, comments) {
  const { facilities, people, rules } = ctx;
  const data = candidate.data;
  const status = data ? getStatus(rules, data.status) : null;

  const rolesSection = data ? renderRolesCard(data, rules, people) : '';

  const nextStepsList = data
    ? nextStepsFor(rules, data.status)
        .map((s) => `<li>${escapeHtml(s)}</li>`)
        .join('')
    : '';

  container.innerHTML = `
    <h1>${escapeHtml(data?.id ?? candidate.issue.title)} ${statusPillHtml(status)}</h1>
    <p class="muted">
      ${data ? `Main lead: <strong>${escapeHtml(findPerson(people, resolveRole(data, 'main_lead', people).personId)?.name ?? 'unassigned')}</strong> · ` : ''}
      ${escapeHtml(data?.tns_name ?? '')} ·
      <a href="${candidate.issue.html_url}" target="_blank" rel="noreferrer">issue #${candidate.issue.number}</a>
      · <button type="button" class="linklike" id="refresh-candidate" title="Re-read this candidate and its tasks from GitHub (also happens automatically when you return to this tab)">↻ Refresh</button>
      <span class="muted">updated ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</span>
      <span id="refresh-error" class="error"></span>
    </p>

    ${rolesSection}
    ${data ? renderChangeStatus(rules, data.status, data) : ''}

    <h2>Visibility</h2>
    ${renderVisibility(data, facilities, rules)}

    <div class="card">
      <h2>Suggested next steps</h2>
      <ul class="next-steps">${nextStepsList || '<li class="muted">None listed for this status.</li>'}</ul>
    </div>

    ${data ? renderImageTimeline(data) : ''}

    ${data ? renderTrackSection(ctx, data, tasks) : `<h2>Tasks</h2>${renderTasks(tasks)}`}
    ${data ? renderAddTask(facilities, tracksForStatus(rules, data.status)) : ''}

    <h2>Observation log</h2>
    ${renderObservationLog(tasks)}

    <h2>Discussion</h2>
    ${renderComments(comments)}

    ${candidate.notes ? `<h2>Notes</h2><div class="card">${escapeHtml(candidate.notes)}</div>` : ''}
  `;

  // Any typing in a form marks the page dirty, so a tab-refocus refresh won't wipe it.
  container.dataset.dirty = '0';
  container.addEventListener('input', markDirty); // same function reference, so re-renders never stack it
  container.querySelector('#refresh-candidate')?.addEventListener('click', () => refreshCandidatePage(container, ctx, candidate));

  if (data) {
    wireChangeStatusForm(container, ctx, candidate, rules, tasks);
    wireRolesForm(container, ctx, candidate, tasks, comments);
    wireImageTimelineForm(container, ctx, candidate, tasks, comments);
    wireMoveToTrack(container, ctx, candidate, tasks, comments);
    wireAddTaskForm(container, ctx, candidate, facilities, tasks, comments);
  }
}
