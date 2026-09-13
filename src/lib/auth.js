// Milestone-1 auth: a GitHub Personal Access Token pasted by the user and
// kept in localStorage. Milestone 2 replaces this with GitHub OAuth via a
// Cloudflare Worker (see plan §1); every other module only calls
// `getToken()`/`clearToken()`, so swapping the storage/flow later does not
// touch the rest of the app.

const STORAGE_KEY = 'lensed-sn-tracker.pat';

export function getToken() {
  try {
    return localStorage.getItem(STORAGE_KEY) || null;
  } catch {
    // localStorage can throw in locked-down browser contexts; treat as signed out.
    return null;
  }
}

export function setToken(token) {
  localStorage.setItem(STORAGE_KEY, token.trim());
}

export function clearToken() {
  localStorage.removeItem(STORAGE_KEY);
}
