// Resources page (plan §8): a sortable table of facilities from
// facilities.yaml, one row per instrument so multi-instrument facilities
// stay comparable side by side.

import { escapeHtml } from '../lib/format.js';
import { findPerson } from '../lib/rules.js';
import { makeSortable } from '../lib/sortable.js';

function rowsFor(facility, people) {
  const instruments = facility.instruments?.length ? facility.instruments : [{ name: '—', modes: [] }];
  return instruments.map((instrument) => {
    // An instrument's own group_holder overrides the facility-level
    // contact.group_holder for that instrument only (facilities.yaml).
    const holderId = instrument.group_holder ?? facility.contact?.group_holder;
    const contactName = findPerson(people, holderId)?.name ?? holderId ?? '—';
    return `
      <tr>
        <td>${escapeHtml(facility.name)}</td>
        <td>${escapeHtml(instrument.name)}</td>
        <td>${escapeHtml((instrument.modes ?? []).join(', ') || '—')}</td>
        <td>${escapeHtml(facility.site?.name ?? '—')}</td>
        <td>${facility.aperture_m ?? '—'}</td>
        <td>${escapeHtml(facility.access?.type ?? '—')}</td>
        <td>${escapeHtml(contactName)}</td>
        <td>${escapeHtml(facility.access?.semester_end ?? '—')}</td>
      </tr>`;
  });
}

export function render(container, ctx) {
  const { facilities, people } = ctx;
  const rows = facilities.flatMap((f) => rowsFor(f, people)).join('');

  container.innerHTML = `
    <h1>Resources</h1>
    <table id="resources-table">
      <thead>
        <tr>
          <th data-sort>Facility</th>
          <th data-sort>Instrument</th>
          <th>Modes</th>
          <th data-sort>Site</th>
          <th data-sort="number">Aperture (m)</th>
          <th data-sort>Access</th>
          <th data-sort>Group holder</th>
          <th data-sort>Semester end</th>
        </tr>
      </thead>
      <tbody>${rows || '<tr><td colspan="8" class="muted">No facilities defined.</td></tr>'}</tbody>
    </table>
  `;

  makeSortable(container.querySelector('#resources-table'));
}
