// Milestone-1 dashboard: candidate, status, leads, "visible tonight: N of M"
// and the first open task by due date, exactly as specified in plan §8.

import { loadCandidateDetail } from '../lib/data.js';
import { getStatus, findPerson, nextStepsFor } from '../lib/rules.js';
import { visibilityTonightAcrossFacilities } from '../lib/visibility.js';
import { escapeHtml, statusPillHtml } from '../lib/format.js';

function candidateRouteId(candidate) {
  return candidate.data?.id ?? `issue-${candidate.issue.number}`;
}

function dueDateOf(task) {
  return task.data?.requested_date || task.data?.deadline || task.data?.scheduled_utc || null;
}

async function nextActionFor(client, candidate, rules) {
  const { tasks } = await loadCandidateDetail(client, candidate);
  const open = tasks.filter((t) => t.issue.state === 'open');
  const dated = open
    .map((task) => ({ task, due: dueDateOf(task) }))
    .filter((t) => t.due)
    .sort((a, b) => new Date(a.due) - new Date(b.due));

  if (dated.length > 0) return `${dated[0].task.issue.title} (due ${dated[0].due})`;
  if (open.length > 0) return open[0].issue.title;

  const [firstStep] = nextStepsFor(rules, candidate.data?.status);
  return firstStep ?? '—';
}

async function buildRow(ctx, candidate) {
  const { client, facilities, people, rules } = ctx;
  const data = candidate.data;
  const routeId = candidateRouteId(candidate);

  if (!data) {
    return { routeId, title: candidate.issue.title, status: null, leads: '—', visible: '—', nextAction: '—' };
  }

  const status = getStatus(rules, data.status);
  const leads = (data.leads ?? []).map((id) => findPerson(people, id)?.name ?? id).join(', ') || '—';
  const { visibleCount, total } = visibilityTonightAcrossFacilities(data, facilities, rules);
  const nextAction = await nextActionFor(client, candidate, rules);

  return {
    routeId,
    title: data.tns_name ?? candidate.issue.title,
    status,
    leads,
    visible: total > 0 ? `${visibleCount} of ${total}` : '—',
    nextAction,
  };
}

export async function render(container, ctx) {
  container.innerHTML = '<h1>Candidates</h1><p class="muted">Loading visibility and next actions…</p>';

  const rows = await Promise.all(ctx.candidates.map((candidate) => buildRow(ctx, candidate)));

  const bodyRows = rows
    .map(
      (row) => `
        <tr>
          <td>
            <a href="#/candidate/${encodeURIComponent(row.routeId)}">${escapeHtml(row.routeId)}</a>
            <div class="muted">${escapeHtml(row.title)}</div>
          </td>
          <td>${statusPillHtml(row.status)}</td>
          <td>${escapeHtml(row.leads)}</td>
          <td>${escapeHtml(row.visible)}</td>
          <td>${escapeHtml(row.nextAction)}</td>
        </tr>`,
    )
    .join('');

  container.innerHTML = `
    <h1>Candidates</h1>
    <table>
      <thead>
        <tr><th>Candidate</th><th>Status</th><th>Leads</th><th>Visible tonight</th><th>Next action</th></tr>
      </thead>
      <tbody>${bodyRows || '<tr><td colspan="5" class="muted">No candidates yet — create one via the candidate issue template in the data repo.</td></tr>'}</tbody>
    </table>
  `;
}
