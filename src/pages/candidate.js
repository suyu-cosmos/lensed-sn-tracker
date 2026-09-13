// Candidate page (plan §8): header, visibility for tonight + the next
// `lookahead_nights` nights per facility, task list, observation log,
// suggested next steps, and threaded comments.
//
// Milestone 1 has no charting dependency, so "visibility panel" renders as
// a per-night summary card (window, best altitude/airmass, min Moon
// separation) rather than a plotted altitude curve — the same numbers a
// curve would be read off of. A real curve is a good Milestone-2 addition
// once a small charting approach is chosen.

import { loadCandidateDetail } from '../lib/data.js';
import { getStatus, resolveAllRoles, findPerson, nextStepsFor } from '../lib/rules.js';
import { upcomingVisibility } from '../lib/visibility.js';
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

    <h2>Visibility</h2>
    ${renderVisibility(data, facilities, rules)}

    <div class="card">
      <h2>Suggested next steps</h2>
      <ul class="next-steps">${nextStepsList || '<li class="muted">None listed for this status.</li>'}</ul>
    </div>

    <h2>Tasks</h2>
    ${renderTasks(tasks)}

    <h2>Observation log</h2>
    ${renderObservationLog(tasks)}

    <h2>Discussion</h2>
    ${renderComments(comments)}

    ${candidate.notes ? `<h2>Notes</h2><div class="card">${escapeHtml(candidate.notes)}</div>` : ''}
  `;
}
