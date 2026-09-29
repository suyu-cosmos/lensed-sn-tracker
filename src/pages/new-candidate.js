// "New candidate" form (Milestone 2, plan §8): creates the parent issue
// with its YAML block and type:candidate/status:*/cand:* labels directly
// via the API — no dependency on GitHub's own issue-form UI, though the
// resulting issue is byte-for-byte the same shape (see write.js).

import { createIssue } from '../lib/github.js';
import { buildCandidateIssue, LENS_TYPES, SN_TYPES } from '../lib/write.js';
import { activeStatuses, findPerson, rolesForStatus, assignablePeople, resolveRole } from '../lib/rules.js';
import { escapeHtml } from '../lib/format.js';
import { parseIssueBody } from '../lib/yaml.js';
import { navigate } from '../router.js';

function optionEls(values, labels = values, selected = null) {
  return values
    .map((v, i) => `<option value="${escapeHtml(v)}" ${v === selected ? 'selected' : ''}>${escapeHtml(labels[i])}</option>`)
    .join('');
}

function renderMainLead(people, role) {
  const holder = role.holder ? findPerson(people, role.holder)?.name ?? role.holder : null;
  const options = assignablePeople(people)
    .map((p) => `<option value="${escapeHtml(p.id)}">${escapeHtml(p.name)} (${escapeHtml(p.id)})</option>`)
    .join('');
  return `<label>Main lead *${role.description ? ` <span class="muted">— ${escapeHtml(role.description)}</span>` : ''}
        <select name="role:${MAIN_LEAD}">
          ${holder ? `<option value="">Group default (${escapeHtml(holder)})</option>` : '<option value="">— choose —</option>'}
          ${options}
        </select>
      </label>`;
}

/**
 * One dropdown per group role (people.yaml `roles:`). The default choice is
 * "Group default (<current holder>)" and writes nothing, so the candidate
 * keeps following the group default if it changes later; picking a person
 * (even the current holder) pins that role for this candidate via
 * `roles_override` — resolution order in plan §4.1.
 */
// The candidate's overall owner (the former separate "leads" field was merged
// into this role). Always shown, outside the collapsible section; it also
// becomes the candidate issue's GitHub assignee.
const MAIN_LEAD = 'main_lead';

function renderRoleOverrides(people) {
  const roles = Object.entries(people.roles ?? {}).filter(([roleId]) => roleId !== MAIN_LEAD);
  const mainLead = people.roles?.[MAIN_LEAD];
  const mainLeadHtml = mainLead ? renderMainLead(people, mainLead) : '';
  if (!roles.length) return mainLeadHtml;
  const everyone = assignablePeople(people);
  const rows = roles
    .map(([roleId, role]) => {
      const holder = role.holder ? findPerson(people, role.holder)?.name ?? role.holder : 'unassigned';
      const options = everyone
        .map((p) => `<option value="${escapeHtml(p.id)}">${escapeHtml(p.name)} (${escapeHtml(p.id)})</option>`)
        .join('');
      return `<label data-role-row="${escapeHtml(roleId)}">${escapeHtml(roleId)}${role.description ? ` <span class="muted">— ${escapeHtml(role.description)}</span>` : ''}
          <select name="role:${escapeHtml(roleId)}">
            <option value="">Group default (${escapeHtml(holder)})</option>
            ${options}
          </select>
        </label>`;
    })
    .join('');
  return `${mainLeadHtml}
      <details class="role-overrides">
        <summary><h3>Roles for this candidate <span class="muted">(optional — defaults to the group roles)</span></h3></summary>
        <p class="muted">Only the roles relevant to the starting status chosen above are shown — the others become relevant later and can be set on the candidate page (or when changing status). Leave a role on "Group default" to follow people.yaml; choosing a person pins it for this candidate only.</p>
        ${rows}
      </details>`;
}

export function render(container, ctx) {
  const { rules, candidates } = ctx;
  const statuses = activeStatuses(rules).length ? activeStatuses(rules) : rules.statuses;
  const defaultStatus = statuses[0]?.id;

  container.innerHTML = `
    <h1>New candidate</h1>
    <form id="new-candidate-form" class="card">
      <p class="muted">Only <strong>id</strong>, <strong>coordinates</strong> and a <strong>main lead</strong> are required — everything else can be filled in later.</p>

      <label>Candidate id * <input name="id" required placeholder="LSN-2026abc" /></label>
      <label>TNS name <input name="tnsName" placeholder="SN 2026abc" /></label>
      <label>Discovery survey <input name="discoverySurvey" /></label>
      <label>Discovery date <input name="discoveryDate" type="date" /></label>
      <label>RA (deg, J2000) * <input name="raDeg" type="text" inputmode="decimal" pattern="[-+]?([0-9]+\.?[0-9]*|\.[0-9]+)" title="A decimal number, e.g. 188.7363" required /></label>
      <label>Dec (deg, J2000) * <input name="decDeg" type="text" inputmode="decimal" pattern="[-+]?([0-9]+\.?[0-9]*|\.[0-9]+)" title="A decimal number, e.g. -21.12" required /></label>

      <h3>Lens</h3>
      <label>Lens name <input name="lensName" /></label>
      <label>Lens redshift <input name="zLens" type="text" inputmode="decimal" pattern="[0-9]+\.?[0-9]*|\.[0-9]+" title="A decimal number, e.g. 0.42" /></label>
      <label>Lens type <select name="lensType">${optionEls(LENS_TYPES, LENS_TYPES, 'galaxy')}</select></label>
      <label>Number of images <input name="nImages" type="number" step="1" /></label>

      <h3>Source</h3>
      <label>Source redshift <input name="zSource" type="text" inputmode="decimal" pattern="[0-9]+\.?[0-9]*|\.[0-9]+" title="A decimal number, e.g. 0.42" /></label>
      <label>SN type <select name="snType">${optionEls(SN_TYPES, SN_TYPES, 'unknown')}</select></label>

      <h3>Status &amp; people's roles</h3>
      <label>Status
        <select name="status">${statuses.map((s) => `<option value="${escapeHtml(s.id)}" ${s.id === defaultStatus ? 'selected' : ''}>${escapeHtml(s.label)}</option>`).join('')}</select>
      </label>
      ${renderRoleOverrides(ctx.people)}

      <div class="form-actions">
        <button type="submit">Create candidate</button>
        <span id="new-candidate-error" class="error"></span>
      </div>
    </form>
  `;

  const form = container.querySelector('#new-candidate-form');
  const statusSelect = form.querySelector('select[name="status"]');
  // Show only the roles that matter for the chosen starting status (rules.yaml `roles:`).
  const relevantRoles = () => new Set(rolesForStatus(rules, statusSelect.value, ctx.people));
  const syncRoleRows = () => {
    const relevant = relevantRoles();
    form.querySelectorAll('[data-role-row]').forEach((row) => {
      row.hidden = !relevant.has(row.dataset.roleRow);
    });
  };
  statusSelect.addEventListener('change', syncRoleRows);
  syncRoleRows();
  const errorEl = container.querySelector('#new-candidate-error');
  const submitBtn = form.querySelector('button[type="submit"]');

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    errorEl.textContent = '';

    const values = Object.fromEntries(new FormData(form).entries());
    const id = values.id.trim();

    if (!id) {
      errorEl.textContent = 'Candidate id is required.';
      return;
    }
    if (candidates.some((c) => c.data?.id === id)) {
      errorEl.textContent = `A candidate with id "${id}" already exists.`;
      return;
    }

    const raDeg = Number(values.raDeg);
    const decDeg = Number(values.decDeg);
    if (!Number.isFinite(raDeg) || !Number.isFinite(decDeg)) {
      errorEl.textContent = 'RA/Dec must be numbers.';
      return;
    }

    const fields = {
      id,
      tnsName: values.tnsName.trim(),
      discoverySurvey: values.discoverySurvey.trim(),
      discoveryDate: values.discoveryDate || null,
      raDeg,
      decDeg,
      lensName: values.lensName.trim(),
      zLens: values.zLens ? Number(values.zLens) : null,
      lensType: values.lensType,
      nImages: values.nImages ? Number(values.nImages) : null,
      zSource: values.zSource ? Number(values.zSource) : null,
      snType: values.snType,
      status: values.status,
      rolesOverride: Object.fromEntries(
        Object.entries(values)
          .filter(([key, value]) => key.startsWith('role:') && value && (key === `role:${MAIN_LEAD}` || relevantRoles().has(key.slice('role:'.length))))
          .map(([key, value]) => [key.slice('role:'.length), value]),
      ),
    };

    // The main lead must resolve (group default or a pick) — it's the candidate's owner and assignee.
    const mainLeadId = resolveRole({ roles_override: fields.rolesOverride }, MAIN_LEAD, ctx.people).personId;
    if (!mainLeadId) {
      errorEl.textContent = 'Choose a main lead (there is no group default for main_lead).';
      return;
    }

    submitBtn.disabled = true;
    submitBtn.textContent = 'Creating…';

    try {
      const { title, body, labels } = buildCandidateIssue(fields);
      const issue = await createIssue(ctx.client, ctx.config.dataRepo, { title, body, labels, assignees: [mainLeadId] });
      // Build the candidate straight from the issue we just got back and
      // merge it into ctx.candidates ourselves, rather than re-listing
      // issues from GitHub immediately afterward: the label-filtered list
      // endpoint has a brief propagation lag right after creation, so a
      // refetch here can race and miss the issue we just made, breaking
      // the very next navigate() below.
      const { data, notes } = parseIssueBody(issue.body);
      ctx.candidates.push({ issue, data, notes });
      navigate(`/candidate/${encodeURIComponent(id)}`);
    } catch (err) {
      errorEl.textContent = `Could not create the candidate: ${err.message}`;
      submitBtn.disabled = false;
      submitBtn.textContent = 'Create candidate';
    }
  });
}
