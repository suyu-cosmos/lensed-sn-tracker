// Candidate page (plan §8; Milestone 2 writes; Milestone 2.5 tracks): header +
// change status, visibility for tonight + the next `lookahead_nights` nights,
// image timeline, follow-up tracks (plan §6.2) with their tasks, add-task /
// trigger form, observation log, suggested next steps, threaded comments.
//
// Milestone 1 has no charting dependency, so "visibility panel" renders as
// a per-night summary card (window, best altitude/airmass, min Moon
// separation) rather than a plotted altitude curve — the same numbers a
// curve would be read off of.

import { loadCandidateDetail, facilityById, buildTaskFromIssue } from '../lib/data.js';
import {
  getStatus,
  resolveAllRoles,
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
} from '../lib/rules.js';
import { nightlyVisibility, upcomingVisibility } from '../lib/visibility.js';
import { createIssue } from '../lib/github.js';
import {
  buildTaskIssue,
  buildTriggerMailto,
  changeCandidateStatus,
  updateCandidateFields,
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

function renderRoles(candidateData, people) {
  const roles = resolveAllRoles(candidateData, people);
  return Object.entries(roles)
    .map(([roleId, { personId, source }]) => {
      const person = personId ? findPerson(people, personId) : null;
      const name = person?.name ?? personId ?? 'unassigned';
      const tag = source === 'default' ? ' <span class="inherited">(inherited)</span>' : '';
      const cls = source === 'unassigned' ? 'unassigned' : '';
      return `<li><strong>${escapeHtml(roleId)}:</strong> <span class="${cls}">${escapeHtml(name)}</span>${tag}</li>`;
    })
    .join('');
}

/**
 * Task table. `opts.track` adds a Track column (rules needed for labels),
 * `opts.image` adds an Image column (per-image tracks).
 */
function renderTasks(tasks, opts = {}) {
  if (!tasks.length) return '<p class="muted">No tasks yet.</p>';
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
      </tr>`,
    )
    .join('');
  return `<div class="table-scroll"><table><thead><tr><th>Task</th><th>Type</th>${opts.track ? '<th>Track</th>' : ''}${
    opts.image ? '<th>Image</th>' : ''
  }<th>State</th><th>Assignees</th></tr></thead><tbody>${rows}</tbody></table></div>`;
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
                ? '<span class="track-state state-done">targeted</span>'
                : `<span class="muted">not targeted</span> <button type="button" class="linklike" data-add-task data-track="${escapeHtml(track.id)}" data-image="${escapeHtml(e.image)}">+ Add for image ${escapeHtml(e.image)}</button>`
            }</li>`,
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
      <p class="muted">Owner: ${escapeHtml(ownerName)}${track.role ? ` (${escapeHtml(track.role)})` : ''}${cadence}</p>
      ${purposes ? `<ul class="purposes">${purposes}</ul>` : ''}
      ${imagesHtml}
      ${trackTasks.length ? renderTasks(trackTasks, { image: track.per_image }) : '<p class="muted">No tasks yet.</p>'}
      ${track.per_image ? '' : `<button type="button" class="linklike" data-add-task data-track="${escapeHtml(track.id)}">+ Add task to this track</button>`}
    </div>`;
}

/** Track cards for the current phase, plus an "Other tasks" card; phases without tracks keep the flat table. */
function renderTrackSection(ctx, data, tasks) {
  const tracks = tracksForStatus(ctx.rules, data.status);
  if (!tracks.length) return `<h2>Tasks</h2>${renderTasks(tasks, { track: true, rules: ctx.rules })}`;
  const inPhase = new Set(tracks.map((t) => t.id));
  const other = tasks.filter((t) => !inPhase.has(t.data?.track));
  return `
    <h2>Follow-up tracks</h2>
    <div class="track-grid">${tracks.map((track) => renderTrackCard(track, data, tasks, ctx.people)).join('')}</div>
    ${
      other.length
        ? `<div class="card"><h3>Other tasks</h3><p class="muted">Untracked, or from a track that isn't part of this phase.</p>${renderTasks(other, { track: true, rules: ctx.rules })}</div>`
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
            <option value="">— none (untracked) —</option>
            ${optionEls(
              tracks.map((t) => t.id),
              tracks.map((t) => t.label ?? t.id),
            )}
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

function wireChangeStatusForm(container, ctx, candidate, rules) {
  const form = container.querySelector('#status-form');
  if (!form) return;
  const select = form.querySelector('select[name="newStatus"]');
  const extra = form.querySelector('#status-extra-fields');
  const errorEl = form.querySelector('#status-error');

  select.addEventListener('change', () => {
    const requires = requiredFieldsFor(rules, select.value);
    extra.innerHTML = requires
      .map((field) => {
        const vocab = vocabulary(rules, field);
        if (vocab.length) {
          return `<label>${escapeHtml(field)} <select name="extra:${field}">${vocab.map((v) => `<option value="${escapeHtml(v.id)}">${escapeHtml(v.label)}</option>`).join('')}</select></label>`;
        }
        return `<label>${escapeHtml(field)} <input name="extra:${field}" required /></label>`;
      })
      .join('');
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
      renderCandidatePage(container, ctx, candidate, tasks, comments);
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

  const currentTrack = () => (trackSelect?.value ? ctx.rules.tracks?.find((t) => t.id === trackSelect.value) ?? null : null);

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
            eligible.map((e) => `${e.image} (detected ${e.detected})${e.targeted ? ' — already targeted' : ''}`),
          )
        : '<option value="">no trailing image detected yet</option>';
      if (preselectImage) imageSelect.value = preselectImage;
    }
    if (trackHint) {
      if (!track?.role) {
        trackHint.textContent = track ? '' : 'Untracked task — no default owner.';
      } else {
        const { personId } = resolveRole(candidate.data, track.role, ctx.people);
        const name = personId ? findPerson(ctx.people, personId)?.name ?? personId : 'nobody (role unassigned)';
        trackHint.textContent = `Will be assigned to ${name} (${track.role}).`;
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
      if ((issue.assignees ?? []).length === 0) {
        const wanted = assignees[0];
        const reminder = wanted
          ? `Task created, but unassigned: GitHub wouldn't assign ${findPerson(ctx.people, wanted)?.name ?? wanted} (${wanted}) — only collaborators on the data repo can be assigned (a placeholder GitHub username in people.yaml can't). Please assign someone by hand${type === 'trigger' ? ' and email the PI (above)' : ''}.`
          : type === 'trigger'
            ? 'No assignee is set on this task — please email the PI (above) and assign someone responsible for the follow-up.'
            : "No assignee is set on this task yet — consider assigning someone so it doesn't get lost.";
        bannerHtml += `<p class="card unassigned">⚠️ ${escapeHtml(reminder)}</p>`;
      }

      // loadCandidateDetail's label-filtered list has the same brief
      // propagation lag right after creation as the new-candidate case
      // (see CLAUDE.md) — merge the task we just made in ourselves rather
      // than trusting the refetch to already include it.
      const fresh = await loadCandidateDetail(ctx.client, candidate);
      if (!fresh.tasks.some((t) => t.issue.number === issue.number)) {
        fresh.tasks.unshift(buildTaskFromIssue(issue));
      }
      renderCandidatePage(container, ctx, candidate, fresh.tasks, fresh.comments);
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

export async function render(container, ctx, params) {
  const { candidates, client } = ctx;
  const candidate = findCandidate(candidates, params.id);

  if (!candidate) {
    container.innerHTML = `<p class="error">No candidate found for "${escapeHtml(params.id)}".</p>`;
    return;
  }

  container.innerHTML = '<p class="muted">Loading candidate…</p>';
  const { tasks, comments } = await loadCandidateDetail(client, candidate);
  renderCandidatePage(container, ctx, candidate, tasks, comments);
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

  const rolesSection = data
    ? `<div class="card"><h2>Roles</h2><ul class="next-steps">${renderRoles(data, people)}</ul></div>`
    : '';

  const nextStepsList = data
    ? nextStepsFor(rules, data.status)
        .map((s) => `<li>${escapeHtml(s)}</li>`)
        .join('')
    : '';

  container.innerHTML = `
    <h1>${escapeHtml(data?.id ?? candidate.issue.title)} ${statusPillHtml(status)}</h1>
    <p class="muted">
      ${escapeHtml(data?.tns_name ?? '')} ·
      <a href="${candidate.issue.html_url}" target="_blank" rel="noreferrer">issue #${candidate.issue.number}</a>
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

  if (data) {
    wireChangeStatusForm(container, ctx, candidate, rules);
    wireImageTimelineForm(container, ctx, candidate, tasks, comments);
    wireAddTaskForm(container, ctx, candidate, facilities, tasks, comments);
  }
}
