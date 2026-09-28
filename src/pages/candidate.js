// Candidate page (plan §8, extended for Milestone 2 §8): header + change
// status, visibility for tonight + the next `lookahead_nights` nights,
// task list, observation log, add-task/trigger form, suggested next
// steps, and threaded comments.
//
// Milestone 1 has no charting dependency, so "visibility panel" renders as
// a per-night summary card (window, best altitude/airmass, min Moon
// separation) rather than a plotted altitude curve — the same numbers a
// curve would be read off of.

import { loadCandidateDetail, facilityById, refreshCandidates } from '../lib/data.js';
import { getStatus, resolveAllRoles, findPerson, nextStepsFor, transitionsFor, requiredFieldsFor, vocabulary } from '../lib/rules.js';
import { nightlyVisibility, upcomingVisibility } from '../lib/visibility.js';
import { createIssue } from '../lib/github.js';
import {
  buildTaskIssue,
  buildTriggerMailto,
  changeCandidateStatus,
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

function renderTasks(tasks) {
  if (!tasks.length) return '<p class="muted">No tasks yet.</p>';
  const rows = tasks
    .map(
      (t) => `
      <tr>
        <td><a href="${t.issue.html_url}" target="_blank" rel="noreferrer">${escapeHtml(t.issue.title)}</a></td>
        <td>${escapeHtml(t.type)}</td>
        <td>${escapeHtml(t.issue.state)}</td>
        <td>${escapeHtml((t.issue.assignees ?? []).map((a) => a.login).join(', ') || '—')}</td>
      </tr>`,
    )
    .join('');
  return `<table><thead><tr><th>Task</th><th>Type</th><th>State</th><th>Assignees</th></tr></thead><tbody>${rows}</tbody></table>`;
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

function renderChangeStatus(rules, currentStatusId) {
  const { declared, other } = transitionsFor(rules, currentStatusId);
  const declaredOptions = declared.map((d) => `<option value="${escapeHtml(d.id)}">${escapeHtml(getStatus(rules, d.id)?.label ?? d.id)} — ${escapeHtml(d.description)}</option>`).join('');
  const otherOptions = other.map((id) => `<option value="${escapeHtml(id)}">${escapeHtml(getStatus(rules, id)?.label ?? id)}</option>`).join('');
  return `
    <div class="card" id="change-status-card">
      <h2>Change status</h2>
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

function renderAddTask(facilities) {
  const facilityOptions = optionEls(
    facilities.map((f) => f.id),
    facilities.map((f) => f.name),
  );
  return `
    <div class="card" id="add-task-card">
      <h2>Add task</h2>
      <form id="add-task-form">
        <label>Type
          <select name="type">${optionEls(TASK_TYPES)}</select>
        </label>

        <fieldset data-type="trigger">
          <label>Facility <select name="facility" data-role="facility">${facilityOptions}</select></label>
          <label>Instrument <select name="instrument" data-role="instrument"></select></label>
          <label>Mode <select name="mode" data-role="mode"></select></label>
          <label>Requested date <input name="requestedDate" type="date" /></label>
          <label>Exposure <input name="exposure" placeholder="4x600s" /></label>
          <label>Images <input name="images" placeholder="A, B" /></label>
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

/** Wire up the facility -> instrument -> mode cascade for one (facility-select, instrument-select[, mode-select]) trio. */
function wireFacilityCascade(form, facilities, facilitySelect, instrumentSelect, modeSelect) {
  function updateInstruments() {
    const facility = facilityById(facilities, facilitySelect.value);
    const instruments = facility?.instruments ?? [];
    instrumentSelect.innerHTML = optionEls(
      instruments.map((i) => i.id),
      instruments.map((i) => i.name),
    );
    if (modeSelect) updateModes();
  }
  function updateModes() {
    const facility = facilityById(facilities, facilitySelect.value);
    const instrument = facility?.instruments?.find((i) => i.id === instrumentSelect.value);
    const modes = instrument?.modes?.length ? instrument.modes : INSTRUMENT_MODES;
    modeSelect.innerHTML = optionEls(modes);
  }
  facilitySelect.addEventListener('change', updateInstruments);
  instrumentSelect.addEventListener('change', () => modeSelect && updateModes());
  updateInstruments();
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
      await changeCandidateStatus(ctx.client, ctx.config.dataRepo, candidate, newStatusId, extraFields);
      // ctx.candidates holds the stale (pre-change) parsed body, so a
      // straight re-render would show the old status — refresh first.
      await refreshCandidates(ctx);
      await render(container, ctx, { id: candidate.data?.id ?? `issue-${candidate.issue.number}` });
    } catch (err) {
      errorEl.textContent = `Could not update status: ${err.message}`;
      submitBtn.disabled = false;
    }
  });
}

function wireAddTaskForm(container, ctx, candidate, facilities) {
  const form = container.querySelector('#add-task-form');
  if (!form) return;
  const typeSelect = form.querySelector('select[name="type"]');
  const errorEl = form.querySelector('#add-task-error');
  const mailtoEl = container.querySelector('#trigger-mailto');

  wireFacilityCascade(
    form,
    facilities,
    form.querySelector('fieldset[data-type="trigger"] [data-role="facility"]'),
    form.querySelector('fieldset[data-type="trigger"] [data-role="instrument"]'),
    form.querySelector('fieldset[data-type="trigger"] [data-role="mode"]'),
  );
  wireFacilityCascade(
    form,
    facilities,
    form.querySelector('fieldset[data-type="observation"] [data-role="facility"]'),
    form.querySelector('fieldset[data-type="observation"] [data-role="instrument"]'),
    null,
  );

  typeSelect.addEventListener('change', () => {
    form.querySelectorAll('fieldset[data-type]').forEach((fs) => {
      fs.hidden = fs.dataset.type !== typeSelect.value;
    });
    mailtoEl.innerHTML = '';
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    errorEl.textContent = '';
    mailtoEl.innerHTML = '';

    const type = typeSelect.value;
    const values = Object.fromEntries(new FormData(form).entries());
    const candidateId = candidate.data.id;

    const fields =
      type === 'trigger'
        ? {
            facility: values.facility,
            instrument: values.instrument,
            mode: values.mode,
            requestedDate: values.requestedDate,
            exposure: values.exposure,
            images: values.images.split(',').map((s) => s.trim()).filter(Boolean),
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

    const submitBtn = form.querySelector('button[type="submit"]');
    submitBtn.disabled = true;
    try {
      const { title, body, labels } = buildTaskIssue(candidateId, type, fields);
      const issue = await createIssue(ctx.client, ctx.config.dataRepo, { title, body, labels });

      // render() below replaces the whole container, including this form,
      // so build the mailto banner's HTML now but only inject it into the
      // DOM *after* re-rendering (into the fresh #trigger-mailto element) —
      // otherwise it would be wiped out the instant it appeared.
      let mailtoBannerHtml = '';
      if (type === 'trigger') {
        const facility = facilityById(facilities, fields.facility);
        const instrument = facility?.instruments?.find((i) => i.id === fields.instrument);
        const visibilityTonight = facility && !facility.space_based
          ? nightlyVisibility({
              raDeg: candidate.data.ra_deg,
              decDeg: candidate.data.dec_deg,
              site: facility.site,
              minAltitudeDeg: facility.min_altitude_deg,
              maxAirmass: facility.max_airmass,
              rules: ctx.rules,
            })
          : null;
        const mailtoUrl = buildTriggerMailto({ candidate: candidate.data, facility, instrument, visibilityTonight });
        mailtoBannerHtml = `<p class="card">Created <a href="${issue.html_url}" target="_blank" rel="noreferrer">#${issue.number}</a>. <a href="${mailtoUrl}">✉️ Email ${escapeHtml(facility?.contact?.pi ?? 'the PI')} about this trigger</a></p>`;
      }

      await render(container, ctx, { id: candidateId });
      if (mailtoBannerHtml) {
        const freshMailtoEl = container.querySelector('#trigger-mailto');
        if (freshMailtoEl) freshMailtoEl.innerHTML = mailtoBannerHtml;
      }
    } catch (err) {
      errorEl.textContent = `Could not create task: ${err.message}`;
      submitBtn.disabled = false;
    }
  });
}

export async function render(container, ctx, params) {
  const { candidates, facilities, people, rules, client } = ctx;
  const candidate = findCandidate(candidates, params.id);

  if (!candidate) {
    container.innerHTML = `<p class="error">No candidate found for "${escapeHtml(params.id)}".</p>`;
    return;
  }

  container.innerHTML = '<p class="muted">Loading candidate…</p>';

  const data = candidate.data;
  const status = data ? getStatus(rules, data.status) : null;
  const { tasks, comments } = await loadCandidateDetail(client, candidate);

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
    ${data ? renderChangeStatus(rules, data.status) : ''}

    <h2>Visibility</h2>
    ${renderVisibility(data, facilities, rules)}

    <div class="card">
      <h2>Suggested next steps</h2>
      <ul class="next-steps">${nextStepsList || '<li class="muted">None listed for this status.</li>'}</ul>
    </div>

    <h2>Tasks</h2>
    ${renderTasks(tasks)}
    ${data ? renderAddTask(facilities) : ''}

    <h2>Observation log</h2>
    ${renderObservationLog(tasks)}

    <h2>Discussion</h2>
    ${renderComments(comments)}

    ${candidate.notes ? `<h2>Notes</h2><div class="card">${escapeHtml(candidate.notes)}</div>` : ''}
  `;

  if (data) {
    wireChangeStatusForm(container, ctx, candidate, rules);
    wireAddTaskForm(container, ctx, candidate, facilities);
  }
}
