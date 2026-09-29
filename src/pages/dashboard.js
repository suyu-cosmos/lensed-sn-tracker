// Dashboard (plan §8 M1, extended in M2.5 Step 5): candidate, status (phase),
// per-track indicators for that phase, main lead, "visible tonight: N of M", and
// a track-aware next action. Finished (terminal-status) candidates are hidden
// by default behind a "Show finished" toggle.

import { loadCandidateDetail } from '../lib/data.js';
import { getStatus, findPerson, resolveRole, isTerminal, trackIndicators, nextAction } from '../lib/rules.js';
import { visibilityTonightAcrossFacilities } from '../lib/visibility.js';
import { escapeHtml, statusPillHtml } from '../lib/format.js';

const SHOW_FINISHED_KEY = 'lensed-sn-tracker.dashboard.showFinished';

// Per-viewer convenience only; storage can be unavailable (private mode etc.).
function loadShowFinished() {
  try {
    return localStorage.getItem(SHOW_FINISHED_KEY) === '1';
  } catch {
    return false;
  }
}
function saveShowFinished(value) {
  try {
    localStorage.setItem(SHOW_FINISHED_KEY, value ? '1' : '0');
  } catch {
    /* ignore */
  }
}

const STATE_SYMBOL = { active: '●', done: '✓', not_started: '○', waiting: '⏳' };
const STATE_TEXT = { active: 'active', done: 'done', not_started: 'not started', waiting: 'waiting for event' };

function candidateRouteId(candidate) {
  return candidate.data?.id ?? `issue-${candidate.issue.number}`;
}

function renderTrackChips(chips) {
  if (!chips.length) return '<span class="muted">—</span>';
  return chips
    .map(
      ({ track, short, state }) =>
        `<span class="track-chip state-${state}" title="${escapeHtml(`${track.label ?? track.id}: ${STATE_TEXT[state]}`)}">${STATE_SYMBOL[state]} ${escapeHtml(short)}</span>`,
    )
    .join(' ');
}

async function buildRow(ctx, candidate) {
  const { client, facilities, people, rules } = ctx;
  const data = candidate.data;
  const routeId = candidateRouteId(candidate);

  if (!data) {
    return { routeId, title: candidate.issue.title, status: null, terminal: false, chips: [], mainLead: '—', visible: '—', action: { text: '—' } };
  }

  const { tasks } = await loadCandidateDetail(client, candidate);
  const { visibleCount, total } = visibilityTonightAcrossFacilities(data, facilities, rules);

  return {
    routeId,
    title: data.tns_name ?? candidate.issue.title,
    status: getStatus(rules, data.status),
    // Unknown statuses are never hidden — a typo in rules.yaml must stay visible (plan §6.1).
    terminal: isTerminal(rules, data.status),
    chips: trackIndicators(rules, data, tasks),
    mainLead: (() => {
      const id = resolveRole(data, 'main_lead', people).personId;
      return id ? findPerson(people, id)?.name ?? id : 'unassigned';
    })(),
    visible: total > 0 ? `${visibleCount} of ${total}` : '—',
    action: nextAction(rules, data, tasks),
  };
}

function renderTable(rows, showFinished) {
  const shown = showFinished ? rows : rows.filter((r) => !r.terminal);
  const hidden = rows.length - shown.length;

  const bodyRows = shown
    .map(
      (row) => `
        <tr class="${row.terminal ? 'finished' : ''}">
          <td>
            <a href="#/candidate/${encodeURIComponent(row.routeId)}">${escapeHtml(row.routeId)}</a>
            <div class="muted">${escapeHtml(row.title)}</div>
          </td>
          <td>${statusPillHtml(row.status)}</td>
          <td class="track-chips">${renderTrackChips(row.chips)}</td>
          <td>${escapeHtml(row.mainLead)}</td>
          <td>${escapeHtml(row.visible)}</td>
          <td class="next-action action-${row.action.kind ?? 'none'}">${escapeHtml(row.action.text)}</td>
        </tr>`,
    )
    .join('');

  const empty = rows.length
    ? `No active candidates — ${hidden} finished ${hidden === 1 ? 'candidate is' : 'candidates are'} hidden.`
    : 'No candidates yet — use "+ New candidate" to add one.';

  return `
    <div class="dashboard-controls">
      <label class="inline-check"><input type="checkbox" id="show-finished" ${showFinished ? 'checked' : ''} /> Show finished candidates</label>
      ${!showFinished && hidden ? `<span class="muted">${hidden} finished hidden</span>` : ''}
    </div>
    <div class="table-scroll">
      <table>
        <thead>
          <tr><th>Candidate</th><th>Status</th><th>Tracks</th><th>Main lead</th><th>Visible tonight</th><th>Next action</th></tr>
        </thead>
        <tbody>${bodyRows || `<tr><td colspan="6" class="muted">${empty}</td></tr>`}</tbody>
      </table>
    </div>
    <p class="muted legend">Tracks: ● active · ○ not started · ⏳ waiting for event · ✓ done — hover a chip for details.</p>`;
}

export async function render(container, ctx) {
  container.innerHTML = '<h1>Candidates</h1><p class="muted">Loading visibility, tracks and next actions…</p>';

  const rows = await Promise.all(ctx.candidates.map((candidate) => buildRow(ctx, candidate)));
  let showFinished = loadShowFinished();

  const draw = () => {
    container.innerHTML = `<h1>Candidates</h1>${renderTable(rows, showFinished)}`;
    container.querySelector('#show-finished').addEventListener('change', (e) => {
      showFinished = e.target.checked;
      saveShowFinished(showFinished);
      draw(); // re-render from rows already loaded — no refetch
    });
  };
  draw();
}
