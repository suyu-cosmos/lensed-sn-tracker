// A minimal hash router — no framework, matching the plan's "plain
// HTML/JS" architecture. Routes are registered as `/path/:param` patterns;
// whichever one matches `location.hash` gets its handler called with the
// extracted params on load and on every `hashchange`.

const routes = [];

export function route(pattern, handler) {
  const paramNames = [];
  const regexSource = pattern.replace(/:[^/]+/g, (token) => {
    paramNames.push(token.slice(1));
    return '([^/]+)';
  });
  routes.push({ regex: new RegExp(`^${regexSource}$`), paramNames, handler });
}

function currentPath() {
  const hash = location.hash.slice(1);
  return hash || '/';
}

function dispatch() {
  const path = currentPath();
  for (const { regex, paramNames, handler } of routes) {
    const match = path.match(regex);
    if (match) {
      const params = Object.fromEntries(paramNames.map((name, i) => [name, decodeURIComponent(match[i + 1])]));
      handler(params, path);
      return;
    }
  }
  console.warn(`No route matched "${path}"`);
}

export function start() {
  window.addEventListener('hashchange', dispatch);
  if (!location.hash) location.hash = '/';
  else dispatch();
}

export function navigate(path) {
  location.hash = path;
}

export function isActive(path) {
  return currentPath() === path || (path !== '/' && currentPath().startsWith(path));
}
