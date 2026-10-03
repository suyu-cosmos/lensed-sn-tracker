// Entry point: PAT login gate, then load the data repo once and hand the
// resulting snapshot to whichever page the router picks.

import { getToken, setToken, clearToken } from './lib/auth.js';
import { loadAppData, config } from './lib/data.js';
import { route, start } from './router.js';
import { installDatePickers } from './lib/dateinput.js';
import * as dashboard from './pages/dashboard.js';
import * as candidatePage from './pages/candidate.js';
import * as resources from './pages/resources.js';
import * as people from './pages/people.js';
import * as newCandidate from './pages/new-candidate.js';

const appEl = document.getElementById('app');
installDatePickers(document); // year-first date fields' 📅 buttons, app-wide

function renderLogin(onSubmit, errorMessage) {
  appEl.innerHTML = `
    <div class="login-box">
      <h1>Lensed SN Tracker</h1>
      <p class="muted">Paste a GitHub personal access token scoped to the data repo (fine-grained: Contents read-only, Issues read &amp; write — writes are needed for the new-candidate/add-task/change-status forms).</p>
      <input id="pat-input" type="password" placeholder="github_pat_..." autocomplete="off" />
      <button id="pat-submit">Continue</button>
      ${errorMessage ? `<p class="error">${errorMessage}</p>` : ''}
    </div>
  `;
  const input = appEl.querySelector('#pat-input');
  const submit = () => {
    const value = input.value.trim();
    if (value) onSubmit(value);
  };
  appEl.querySelector('#pat-submit').addEventListener('click', submit);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') submit();
  });
}

function updateNav(nav) {
  const path = location.hash.slice(1) || '/';
  nav.innerHTML = `
    <a href="#/" class="${path === '/' ? 'active' : ''}">Dashboard</a>
    <a href="#/resources" class="${path.startsWith('/resources') ? 'active' : ''}">Resources</a>
    <a href="#/people" class="${path.startsWith('/people') ? 'active' : ''}">People</a>
    <a href="#/new-candidate" class="${path.startsWith('/new-candidate') ? 'active' : ''}">+ New candidate</a>
    <span class="spacer"></span>
    <button class="linklike" id="sign-out">Sign out</button>
  `;
  nav.querySelector('#sign-out').addEventListener('click', () => {
    clearToken();
    location.reload();
  });
}

/**
 * "build <date> UT · <commit>" — injected at build time by vite.config.js.
 * Lets anyone check which version they're seeing (Pages caches ~10 min).
 */
function versionStampHtml() {
  const commit = typeof __BUILD_COMMIT__ !== 'undefined' ? __BUILD_COMMIT__ : 'dev';
  const built = typeof __BUILD_TIME__ !== 'undefined' ? __BUILD_TIME__ : null;
  const when = built ? `${built.slice(0, 16).replace('T', ' ')} UT` : 'dev build';
  const { owner, name } = config.codeRepo ?? {};
  const commitHtml =
    owner && name && commit !== 'unknown' && commit !== 'dev'
      ? `<a href="https://github.com/${owner}/${name}/commit/${commit}" target="_blank" rel="noreferrer">${commit}</a>`
      : commit;
  return `lensed-sn-tracker · build ${when} · ${commitHtml}`;
}

async function boot() {
  const token = getToken();
  if (!token) {
    renderLogin(async (value) => {
      setToken(value);
      await boot();
    });
    return;
  }

  appEl.innerHTML = '<p class="loading">Loading data repo…</p>';

  let ctx;
  try {
    ctx = await loadAppData(token);
  } catch (err) {
    clearToken();
    renderLogin(
      async (value) => {
        setToken(value);
        await boot();
      },
      `Could not load the data repo: ${err.message}. Check the token's scopes and repo access, then try again.`,
    );
    return;
  }

  appEl.innerHTML = '';
  const nav = document.createElement('nav');
  nav.className = 'topnav';
  const content = document.createElement('div');
  const footer = document.createElement('footer');
  footer.className = 'version-stamp';
  footer.innerHTML = versionStampHtml();
  appEl.append(nav, content, footer);

  route('/', () => {
    updateNav(nav);
    dashboard.render(content, ctx);
  });
  route('/resources', () => {
    updateNav(nav);
    resources.render(content, ctx);
  });
  route('/people', () => {
    updateNav(nav);
    people.render(content, ctx);
  });
  route('/candidate/:id', (params) => {
    updateNav(nav);
    candidatePage.render(content, ctx, params);
  });
  route('/new-candidate', () => {
    updateNav(nav);
    newCandidate.render(content, ctx);
  });

  start();
}

boot();
