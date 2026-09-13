// People page (plan §8): a sortable table of people.yaml plus the
// group-wide default role assignments (holder/deputy) below it.

import { escapeHtml } from '../lib/format.js';
import { makeSortable } from '../lib/sortable.js';

function personRow(person) {
  return `
    <tr>
      <td>${escapeHtml(person.name)} <span class="muted">(${escapeHtml(person.id)})</span></td>
      <td>${escapeHtml(person.institution ?? '—')}</td>
      <td>${escapeHtml(person.timezone ?? '—')}</td>
      <td>${escapeHtml((person.roles ?? []).join(', ') || '—')}</td>
      <td>${escapeHtml((person.expertise ?? []).join(', ') || '—')}</td>
      <td>${escapeHtml((person.facilities ?? []).join(', ') || '—')}</td>
    </tr>`;
}

function roleRow(roleId, role, people) {
  const holderName = people.find((p) => p.id === role.holder)?.name ?? role.holder;
  const deputyName = people.find((p) => p.id === role.deputy)?.name ?? role.deputy ?? '—';
  return `
    <tr>
      <td>${escapeHtml(roleId)}</td>
      <td>${escapeHtml(holderName)}</td>
      <td>${escapeHtml(deputyName)}</td>
      <td class="muted">${escapeHtml(role.description ?? '')}</td>
    </tr>`;
}

export function render(container, ctx) {
  const { people } = ctx;
  const peopleRows = (people.people ?? []).map(personRow).join('');
  const roleRows = Object.entries(people.roles ?? {})
    .map(([roleId, role]) => roleRow(roleId, role, people.people ?? []))
    .join('');

  container.innerHTML = `
    <h1>People</h1>
    <table id="people-table">
      <thead>
        <tr>
          <th data-sort>Name</th>
          <th data-sort>Institution</th>
          <th data-sort>Timezone</th>
          <th>Roles</th>
          <th>Expertise</th>
          <th>Facilities</th>
        </tr>
      </thead>
      <tbody>${peopleRows || '<tr><td colspan="6" class="muted">No people defined.</td></tr>'}</tbody>
    </table>

    <h2>Group default roles</h2>
    <p class="muted">Per-candidate <code>roles_override</code> takes precedence over these; see the candidate page.</p>
    <table id="roles-table">
      <thead><tr><th data-sort>Role</th><th data-sort>Holder</th><th data-sort>Deputy</th><th>Description</th></tr></thead>
      <tbody>${roleRows || '<tr><td colspan="4" class="muted">No default roles defined.</td></tr>'}</tbody>
    </table>
  `;

  makeSortable(container.querySelector('#people-table'));
  makeSortable(container.querySelector('#roles-table'));
}
