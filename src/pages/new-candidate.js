// "New candidate" form (Milestone 2, plan §8): creates the parent issue
// with its YAML block and type:candidate/status:*/cand:* labels directly
// via the API — no dependency on GitHub's own issue-form UI, though the
// resulting issue is byte-for-byte the same shape (see write.js).

import { createIssue } from '../lib/github.js';
import { refreshCandidates } from '../lib/data.js';
import { buildCandidateIssue, LENS_TYPES, SN_TYPES } from '../lib/write.js';
import { activeStatuses } from '../lib/rules.js';
import { escapeHtml } from '../lib/format.js';
import { navigate } from '../router.js';

function optionEls(values, labels = values, selected = null) {
  return values
    .map((v, i) => `<option value="${escapeHtml(v)}" ${v === selected ? 'selected' : ''}>${escapeHtml(labels[i])}</option>`)
    .join('');
}

export function render(container, ctx) {
  const { rules, candidates } = ctx;
  const statuses = activeStatuses(rules).length ? activeStatuses(rules) : rules.statuses;
  const defaultStatus = statuses[0]?.id;

  container.innerHTML = `
    <h1>New candidate</h1>
    <form id="new-candidate-form" class="card">
      <p class="muted">Only <strong>id</strong>, <strong>leads</strong>, and coordinates are required — everything else can be filled in later by editing the issue directly.</p>

      <label>Candidate id * <input name="id" required placeholder="LSN-2026abc" /></label>
      <label>TNS name <input name="tnsName" placeholder="SN 2026abc" /></label>
      <label>Discovery survey <input name="discoverySurvey" /></label>
      <label>Discovery date <input name="discoveryDate" type="date" /></label>
      <label>RA (deg, J2000) * <input name="raDeg" type="number" step="any" required /></label>
      <label>Dec (deg, J2000) * <input name="decDeg" type="number" step="any" required /></label>

      <h3>Lens</h3>
      <label>Lens name <input name="lensName" /></label>
      <label>Lens redshift <input name="zLens" type="number" step="any" /></label>
      <label>Lens type <select name="lensType">${optionEls(LENS_TYPES, LENS_TYPES, 'galaxy')}</select></label>
      <label>Number of images <input name="nImages" type="number" step="1" /></label>

      <h3>Source</h3>
      <label>Source redshift <input name="zSource" type="number" step="any" /></label>
      <label>SN type <select name="snType">${optionEls(SN_TYPES, SN_TYPES, 'unknown')}</select></label>

      <h3>Ownership</h3>
      <label>Leads (GitHub usernames) * <input name="leads" required placeholder="suyu-cosmos, mkim" /></label>
      <label>Status
        <select name="status">${statuses.map((s) => `<option value="${escapeHtml(s.id)}" ${s.id === defaultStatus ? 'selected' : ''}>${escapeHtml(s.label)}</option>`).join('')}</select>
      </label>

      <div class="form-actions">
        <button type="submit">Create candidate</button>
        <span id="new-candidate-error" class="error"></span>
      </div>
    </form>
  `;

  const form = container.querySelector('#new-candidate-form');
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

    const leads = values.leads
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    if (!leads.length) {
      errorEl.textContent = 'At least one lead is required.';
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
      leads,
      status: values.status,
    };

    submitBtn.disabled = true;
    submitBtn.textContent = 'Creating…';

    try {
      const { title, body, labels } = buildCandidateIssue(fields);
      await createIssue(ctx.client, ctx.config.dataRepo, { title, body, labels, assignees: leads });
      await refreshCandidates(ctx);
      navigate(`/candidate/${encodeURIComponent(id)}`);
    } catch (err) {
      errorEl.textContent = `Could not create the candidate: ${err.message}`;
      submitBtn.disabled = false;
      submitBtn.textContent = 'Create candidate';
    }
  });
}
