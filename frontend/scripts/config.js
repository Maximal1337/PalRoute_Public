/**
 * Deployment config. A plain script rather than a module, so a deploy can
 * rewrite it without a build step. `apiBase` is '' for same origin, '/api'
 * behind a rewrite, or an absolute URL. Overridden by ?api= and localStorage.
 */
window.PALROUTE_CONFIG = {
  apiBase: '/api',
};
