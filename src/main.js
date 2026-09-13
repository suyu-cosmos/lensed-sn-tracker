// Entry point: PAT login gate, then load the data repo once and hand the
// resulting snapshot to whichever page the router picks.

import { getToken, setToken, clearToken } from './lib/auth.js';
import { loadAppData } from './lib/data.js';
import { route, start } from './router.js';
import * as dashboard from './pages/dashboard.js';
import * as candidatePage from './pages/candidate.js';
import * as resources from './pages/resources.js';
import * as people from './pages/people.js';

const appEl = document.getElementById('app');

function renderLogin(onSubmit, errorMessage) {
  appEl.innerHTML = `
    <div class="login-box">
      <h1>Lensed SN Tracker</h1>
      <p class="muted">Paste a GitHub personal access token with read access to the data repo (fine-grained: Issues + Contents, read-only).</p>
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
    <span class="spacer"></span>
    <button class="linklike" id="sign-out">Sign out</button>
  `;
  nav.querySelector('#sign-out').addEventListener('click', () => {
    clearToken();
    location.reload();
  });
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
  appEl.append(nav, content);

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

  start();
}

boot();
