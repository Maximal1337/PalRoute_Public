// PalRoute API client. Query endpoints use POST, since `unlockedBeacons` is
// too large for a query string.

/**
 * Resolve the API base address: ?api=, then localStorage, then config.js.
 */
function resolveApiBase() {
  const fromQuery = new URLSearchParams(location.search).get('api');
  if (fromQuery !== null) return fromQuery;
  try {
    const stored = localStorage.getItem('palroute.api');
    if (stored !== null) return stored;
  } catch { /* private mode */ }
  return window.PALROUTE_CONFIG?.apiBase ?? '/api';
}

export const API_ORIGIN = resolveApiBase();

/** True when calls leave this origin, meaning CORS applies. */
export const API_IS_CROSS_ORIGIN =
  API_ORIGIN !== '' && !API_ORIGIN.startsWith('/');

/** Human-readable target, for error messages. */
export const API_LABEL = API_IS_CROSS_ORIGIN
  ? API_ORIGIN
  : `${location.origin}${API_ORIGIN} (same origin)`;

export class ApiError extends Error {
  constructor(message, { status = 0, url = '', cause } = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.url = url;
    this.cause = cause;
  }
}

async function request(path, { method = 'GET', body, signal } = {}) {
  const url = `${API_ORIGIN}${path}`;
  let res;
  try {
    res = await fetch(url, {
      method,
      signal,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (err) {
    if (err?.name === 'AbortError') throw err;
    // Network-level failure, reported as an unreachable API.
    throw new ApiError(
      `Cannot reach the PalRoute API at ${API_LABEL}.`,
      { url, cause: err },
    );
  }

  const text = await res.text();
  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      throw new ApiError(`Malformed JSON from ${path}`, { status: res.status, url });
    }
  }

  if (!res.ok) {
    throw new ApiError(data?.error ?? `${res.status} ${res.statusText}`, {
      status: res.status,
      url,
    });
  }
  return data;
}

/** Strip empty values so the backend sees absent rather than "". */
function clean(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null || v === '') continue;
    if (Array.isArray(v) && v.length === 0 && k !== 'unlockedBeacons') continue;
    out[k] = v;
  }
  return out;
}

/** Shape a UI query into the backend's parameter names. `unlockedBeacons` is always sent, even empty. */
export function toQuery(state) {
  return clean({
    kind: state.kinds?.length ? state.kinds.join(',') : undefined,
    // Array on POST; the backend also accepts CSV on GET.
    biome: state.biome?.length ? state.biome : undefined,
    levelMin: state.levelMin,
    levelMax: state.levelMax,
    search: state.search,
    mount: state.mount,
    teleportCost: state.teleportCost,
    unlockedBeacons: state.unlockedBeacons ?? [],
    limit: state.limit,
  });
}

/**
 * Distinguish a dead server from a CORS block. A `no-cors` request resolves
 * opaquely whenever something answers, and rejects only when nothing listens.
 */
export async function diagnose() {
  // Same-origin: the page's own server is not forwarding /api.
  if (!API_IS_CROSS_ORIGIN) {
    return {
      kind: 'down',
      title: 'The API is not reachable through this origin',
      detail:
        `${location.origin}${API_ORIGIN} is not answering.\n\n` +
        `Locally, start the API:\n  cd backend && npm run serve\n\n` +
        `If deployed, check that your host rewrites ${API_ORIGIN} to the backend, ` +
        `or set apiBase in scripts/config.js to the API's own URL.`,
    };
  }

  let listening = false;
  try {
    await fetch(`${API_ORIGIN}/health`, { mode: 'no-cors', cache: 'no-store' });
    listening = true;
  } catch {
    listening = false;
  }

  if (listening) {
    return {
      kind: 'blocked',
      title: 'API is running but the browser blocked the response',
      detail:
        `${API_ORIGIN} answered, but the browser rejected it — almost always CORS.\n\n` +
        `The API must allow this origin. On the backend set:\n` +
        `  PALROUTE_CORS_ORIGINS=${location.origin}\n\n` +
        `That allowlist is the security boundary for a separately hosted API, ` +
        `so it has to name you explicitly.`,
    };
  }

  return {
    kind: 'down',
    title: 'Nothing is listening on the API port',
    detail:
      `No server answered at ${API_ORIGIN}.\n\n` +
      `Start it:\n  cd backend && npm run serve\n\n` +
      `If that command exits straight away, the dataset is missing — build it first:\n` +
      `  npm run data:fetch\n  npm run data:build`,
  };
}

export const api = {
  health: (signal) => request('/health', { signal }),
  meta: (signal) => request('/meta', { signal }),

  pois: (params = {}, signal) => {
    const qs = new URLSearchParams();
    if (params.kind) qs.set('kind', params.kind);
    if (params.biome && params.biome !== 'all') qs.set('biome', params.biome);
    if (params.limit) qs.set('limit', String(params.limit));
    const q = qs.toString();
    return request(`/pois${q ? `?${q}` : ''}`, { signal });
  },

  beacons: (signal) => request('/beacons', { signal }),

  nearest: (state, signal) =>
    request('/nearest', { method: 'POST', body: toQuery(state), signal }),

  route: (poiId, state, signal) =>
    request(`/route/${encodeURIComponent(poiId)}`, {
      method: 'POST',
      body: toQuery(state),
      signal,
    }),

  tour: (state, signal) =>
    request('/tour', {
      method: 'POST',
      body: { ...toQuery(state), onePer: state.onePer, withRoutes: true },
      signal,
    }),

  validate: (signal) => request('/validate', { signal }),
};
