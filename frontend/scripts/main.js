// App bootstrap and wiring. Loads /meta and /pois once, then re-queries per run.
// Marker highlighting is client-side; routing is done by the backend.
import { api, ApiError, API_LABEL, diagnose } from './api.js';
import { BASE_MAP, loadBaseMap, resetPlacement, savePlacement } from './basemap.js';

/** Must match the backend's BIOME_NONE sentinel. */
const BIOME_NONE = '(none)';
import { debounce, duration, titleCase } from './format.js';
import { MapView } from './map.js';
import { KIND_ORDER } from './palette.js';
import {
  renderFootnote,
  renderLegend,
  renderNearest,
  renderNotices,
  renderRoute,
  renderTooltip,
  renderTour,
  usedBeaconsFrom,
} from './ui.js';

const $ = (sel) => document.querySelector(sel);

const el = {
  conn: $('#conn'),
  connLabel: $('#conn-label'),
  sidebar: $('#sidebar'),
  results: $('#results'),
  resultsTitle: $('#results-title'),
  resultsMeta: $('#results-meta'),
  resultsBody: $('#results-body'),
  scrim: $('#scrim'),
  canvas: $('#map'),
  tooltip: $('#tooltip'),
  legend: $('#legend'),
  scalebar: $('#scalebar'),
  empty: $('#map-empty'),
  emptyTitle: $('#map-empty-title'),
  emptyBody: $('#map-empty-body'),
  loading: $('#map-loading'),
  run: $('#run'),
  clear: $('#clear'),
  modeHint: $('#mode-hint'),
  kind: $('#f-kind'),
  biome: $('#f-biome'),
  kindCount: $('#kind-count'),
  biomeCount: $('#biome-count'),
  filterDiagnosis: $('#filter-diagnosis'),
  levelMin: $('#f-level-min'),
  levelMax: $('#f-level-max'),
  search: $('#f-search'),
  mount: $('#f-mount'),
  mountHint: $('#mount-hint'),
  teleport: $('#f-teleport'),
  tpValue: $('#tp-value'),
  beaconList: $('#beacon-list'),
  beaconSearch: $('#beacon-search'),
  beaconCount: $('#beacon-count'),
  optLabels: $('#opt-labels'),
  optAllPois: $('#opt-all-pois'),
  optGrid: $('#opt-grid'),
  optBasemap: $('#opt-basemap'),
  optBasemapOn: $('#opt-basemap-on'),
  optOpacity: $('#opt-opacity'),
  optOffmap: $('#opt-offmap'),
  offmapNote: $('#offmap-note'),
  opacityValue: $('#opacity-value'),
  basemapFitNote: $('#basemap-fit-note'),
};

const state = {
  mode: 'nearest',
  meta: null,
  pois: [],
  poiById: new Map(),
  beacons: [],
  unlocked: new Set(loadUnlocked()),
  selectedId: null,
  kinds: [],
  biomes: [],
  levelMin: null,
  levelMax: null,
  search: '',
  mount: null,
  teleportCost: 20,
  onePer: null,
  busy: false,
  baseImage: null,
  terrainNote: null,
};

let map;
let inflight = null;

// ---------------------------------------------------------------- persistence

function loadUnlocked() {
  try {
    return JSON.parse(localStorage.getItem('palroute.beacons') ?? '[]');
  } catch {
    return [];
  }
}

function saveUnlocked() {
  try {
    localStorage.setItem('palroute.beacons', JSON.stringify([...state.unlocked]));
  } catch { /* private mode — not worth failing over */ }
}

// ---------------------------------------------------------------- connection

function setConn(stateName, label) {
  el.conn.dataset.state = stateName;
  el.connLabel.textContent = label;
  // Tooltip shows the API address.
  el.conn.title = `API: ${API_LABEL}`;
}

function showError(title, body) {
  el.emptyTitle.textContent = title;
  el.emptyBody.textContent = body;
  el.empty.hidden = false;
}

function setBusy(on) {
  state.busy = on;
  el.loading.hidden = !on;
  el.run.disabled = on;
  el.run.textContent = on ? 'Working…' : 'Run';
}

// ---------------------------------------------------------------- boot

async function boot() {
  setConn('connecting', 'connecting…');
  el.empty.hidden = true;

  try {
    const meta = await api.meta();
    state.meta = meta;

    setConn('ok', `${meta.dataset.poi_count} POIs`);

    const poiRes = await api.pois();
    state.pois = poiRes.pois;
    state.poiById = new Map(state.pois.map((p) => [p.poi_id, p]));

    // After the POIs, so filter options can show counts.
    applyMeta(meta);

    const beaconRes = await api.beacons();
    state.beacons = beaconRes.beacons;

    // Drop stored beacon ids that no longer exist (e.g. dataset rebuilt).
    const valid = new Set(state.beacons.map((b) => b.poi_id));
    for (const id of [...state.unlocked]) if (!valid.has(id)) state.unlocked.delete(id);

    map.setProjectionTransform(meta.map_transform);
    map.setPois(state.pois);
    map.setUnlockedBeacons(state.unlocked);

    // Loaded before the first fit, since the projection outputs image pixels.
    const base = await loadBaseMap();
    if (base) {
      state.baseImage = base;
      map.setBaseImage(base);
      el.basemapFitNote.textContent =
        `Alignment derived by correlating POI density against land density ` +
        `(r=${BASE_MAP.fit.correlation}, ${(BASE_MAP.fit.poisOnLand * 100).toFixed(0)}% of POIs on land ` +
        `vs a ${(BASE_MAP.fit.randomBaseline * 100).toFixed(0)}% baseline, ` +
        `${BASE_MAP.fit.landmassCoverage} landmasses covered) and confirmed by eye. ` +
        `These controls are here for a different map image.`;
    } else {
      // Without an image the grid is the only spatial reference.
      el.optGrid.checked = true;
      map.setOption('grid', true);
      el.optBasemapOn.checked = false;
      el.optBasemapOn.disabled = true;
    }
    map.fit();

    const off = map.offMapCount();
    if (off > 0) {
      el.offmapNote.hidden = false;
      el.offmapNote.textContent =
        `${off} POIs sit outside the Palpagos image — the World Tree is a ` +
        `separate map in game. They keep their own layout inside a labelled ` +
        `frame; untick to hide them (routes to them still work).`;
    }

    renderBeaconList();
    updateLegend();
    applyClientFilter();
    el.empty.hidden = true;
  } catch (err) {
    setConn('error', 'offline');

    // An HTTP status means the API answered; probe only when it did not.
    if (err instanceof ApiError && err.status > 0) {
      // 503 comes from the dev proxy when the backend is down.
      showError(
        err.status === 503 ? 'Backend not running' : `API returned ${err.status}`,
        err.message,
      );
      return;
    }

    if (err instanceof ApiError) {
      const diag = await diagnose();
      showError(diag.title, diag.detail);
      return;
    }

    showError('Something went wrong', String(err?.stack ?? err?.message ?? err));
  }
}

function applyMeta(meta) {
  // Rendered once as a footnote under the results.
  state.terrainNote = meta.terrain?.tier === 'B' ? meta.terrain.banner : null;

  const kindCounts = {};
  for (const p of state.pois) kindCounts[p.kind] = (kindCounts[p.kind] ?? 0) + 1;
  el.kind.innerHTML = KIND_ORDER.filter((k) => meta.kinds.includes(k))
    .map((k) => `<option value="${k}">${titleCase(k)} (${kindCounts[k] ?? 0})</option>`)
    .join('');

  // Per-option counts, including the no-biome bucket.
  const biomeCounts = {};
  let noBiome = 0;
  for (const p of state.pois) {
    if (p.biome) biomeCounts[p.biome] = (biomeCounts[p.biome] ?? 0) + 1;
    else noBiome++;
  }
  el.biome.innerHTML =
    meta.biomes
      .map((b) => `<option value="${b}">${titleCase(b)} (${biomeCounts[b] ?? 0})</option>`)
      .join('') +
    `<option value="${BIOME_NONE}">(no biome) (${noBiome})</option>`;

  el.mount.innerHTML = meta.profiles
    .map(
      (p) =>
        `<option value="${p.name}" ${p.name === meta.default_profile ? 'selected' : ''}>
           ${titleCase(p.name)}${p.can_fly ? ' ✈' : ''}
         </option>`,
    )
    .join('');
  state.mount = meta.default_profile;
  updateMountHint();

  state.teleportCost = meta.teleport_cost_seconds;
  el.teleport.value = String(state.teleportCost);
  el.tpValue.textContent = `${state.teleportCost} s`;
}

function updateMountHint() {
  const p = state.meta?.profiles.find((x) => x.name === state.mount);
  if (!p) return;
  el.mountHint.textContent =
    `${p.description} — ${p.v_ground} m/s ground` +
    (p.can_fly ? `, ${p.v_mount} m/s flying` : '') +
    (p.speed_source?.includes('estimate') ? '. Speeds are unverified estimates.' : '');
}

// ---------------------------------------------------------------- filtering

/** POIs matching the current filters. Client-side only. */
function matchedIds() {
  const kinds = state.kinds;
  const biomes = state.biomes;
  const q = state.search.trim().toLowerCase();
  const ids = [];
  for (const p of state.pois) {
    if (kinds.length && !kinds.includes(p.kind)) continue;
    if (biomes.length) {
      // Mirrors the backend's filter, sentinel included.
      const ok = p.biome === null ? biomes.includes(BIOME_NONE) : biomes.includes(p.biome);
      if (!ok) continue;
    }
    if (state.levelMin !== null && (p.boss_level ?? -Infinity) < state.levelMin) continue;
    if (state.levelMax !== null && (p.boss_level ?? Infinity) > state.levelMax) continue;
    if (q && !`${p.name} ${p.poi_id}`.toLowerCase().includes(q)) continue;
    ids.push(p.poi_id);
  }
  return ids;
}

function applyClientFilter() {
  const ids = matchedIds();
  map.setMatched(ids);
  el.resultsMeta.textContent = `${ids.length} match${ids.length === 1 ? '' : 'es'}`;
  el.kindCount.textContent = state.kinds.length ? `${state.kinds.length} selected` : 'all';
  el.biomeCount.textContent = state.biomes.length ? `${state.biomes.length} selected` : 'all';
  updateLegend();

  // Show the reason next to the control that caused it.
  const why = ids.length === 0 ? diagnoseEmptyFilter() : null;
  el.filterDiagnosis.hidden = why === null;
  if (why) el.filterDiagnosis.textContent = why;
}

/**
 * Local copy of the backend's empty-filter diagnosis. Filters combine with
 * AND, so each is dropped in turn to find the limiting one.
 */
function diagnoseEmptyFilter() {
  const count = (over) => {
    const q = over.search?.trim().toLowerCase() ?? '';
    let n = 0;
    for (const p of state.pois) {
      if (over.kinds.length && !over.kinds.includes(p.kind)) continue;
      if (over.biomes.length) {
        const ok = p.biome === null ? over.biomes.includes(BIOME_NONE) : over.biomes.includes(p.biome);
        if (!ok) continue;
      }
      if (over.levelMin !== null && (p.boss_level ?? -Infinity) < over.levelMin) continue;
      if (over.levelMax !== null && (p.boss_level ?? Infinity) > over.levelMax) continue;
      if (q && !`${p.name} ${p.poi_id}`.toLowerCase().includes(q)) continue;
      n++;
    }
    return n;
  };
  const base = {
    kinds: state.kinds,
    biomes: state.biomes,
    levelMin: state.levelMin,
    levelMax: state.levelMax,
    search: state.search,
  };

  // No selected kind carries a biome at all.
  if (state.biomes.length && state.kinds.length) {
    const anyBiomed = state.pois.some((p) => state.kinds.includes(p.kind) && p.biome);
    if (!anyBiomed) {
      return `None of the selected kinds have biome data — only boss spawners do. Clear the biome filter, or pick "(no biome)".`;
    }
  }

  const drops = [
    state.kinds.length && { label: 'Kind', n: count({ ...base, kinds: [] }) },
    state.biomes.length && { label: 'Biome', n: count({ ...base, biomes: [] }) },
    (state.levelMin !== null || state.levelMax !== null) && {
      label: 'Level range',
      n: count({ ...base, levelMin: null, levelMax: null }),
    },
    state.search && { label: 'Search', n: count({ ...base, search: '' }) },
  ].filter((d) => d && d.n > 0);

  if (!drops.length) return 'Nothing matches, and relaxing any single filter still finds nothing.';
  const best = drops.sort((a, b) => b.n - a.n)[0];
  return `Nothing matches. ${best.label} is the limiting filter — clearing it finds ${best.n}.`;
}

function updateLegend() {
  const counts = {};
  for (const p of state.pois) counts[p.kind] = (counts[p.kind] ?? 0) + 1;
  el.legend.innerHTML = renderLegend(counts, map.hiddenKinds);
}

// ---------------------------------------------------------------- beacons

function renderBeaconList() {
  const q = el.beaconSearch.value.trim().toLowerCase();
  const list = state.beacons.filter(
    (b) => !q || b.name.toLowerCase().includes(q) || b.poi_id.toLowerCase().includes(q),
  );

  el.beaconList.innerHTML = list
    .map(
      (b) => `
      <label class="beacon-item" title="${b.name}">
        <input type="checkbox" value="${b.poi_id}" ${state.unlocked.has(b.poi_id) ? 'checked' : ''}>
        <span>${b.name}</span>
      </label>`,
    )
    .join('');

  el.beaconCount.textContent = `${state.unlocked.size} / ${state.beacons.length}`;
}

function setUnlocked(ids) {
  state.unlocked = new Set(ids);
  saveUnlocked();
  map.setUnlockedBeacons(state.unlocked);
  renderBeaconList();
}

// ---------------------------------------------------------------- queries

function queryState(extra = {}) {
  return {
    kinds: state.kinds,
    biome: state.biomes,
    levelMin: state.levelMin ?? undefined,
    levelMax: state.levelMax ?? undefined,
    search: state.search || undefined,
    mount: state.mount,
    teleportCost: state.teleportCost,
    unlockedBeacons: [...state.unlocked],
    ...extra,
  };
}

async function run() {
  if (state.busy) return;
  inflight?.abort();
  inflight = new AbortController();
  setBusy(true);

  try {
    if (state.mode === 'nearest') {
      const data = await api.nearest(queryState({ limit: 40 }), inflight.signal);
      el.resultsTitle.textContent = 'Nearest';
      el.resultsBody.innerHTML = renderNearest(data) + renderFootnote(state.terrainNote);
      map.clearRoutes();
      map.setUsedBeacons(usedBeaconsFrom(data));
      if (data.results?.length) {
        const pois = data.results.slice(0, 12).map((r) => state.poiById.get(r.poi.poi_id)).filter(Boolean);
        map.frame(pois);
      }
    } else if (state.mode === 'route') {
      if (!state.selectedId) {
        el.resultsBody.innerHTML = `<p class="empty-note">Click a point on the map to route to it.</p>`;
        return;
      }
      const data = await api.route(state.selectedId, queryState(), inflight.signal);
      el.resultsTitle.textContent = 'Route';
      el.resultsBody.innerHTML = renderRoute(data) + renderFootnote(state.terrainNote);
      map.setRoute(data.route);
      map.setUsedBeacons(usedBeaconsFrom(data));
      if (data.route?.legs?.length) {
        const pts = [data.route.legs[0].from, ...data.route.legs.map((l) => l.to)];
        map.frame(pts);
      }
    } else {
      const data = await api.tour(queryState(), inflight.signal);
      el.resultsTitle.textContent = 'Tour';
      el.resultsBody.innerHTML = renderTour(data) + renderFootnote(state.terrainNote);
      map.setTour(data);
      map.setUsedBeacons(usedBeaconsFrom(data));
      if (data.stops?.length) map.frame(data.stops.map((s) => s.poi));
    }
    openResultsOnNarrow();
  } catch (err) {
    if (err?.name === 'AbortError') return;
    el.resultsBody.innerHTML = `<div class="notice notice--warn">${
      err instanceof ApiError ? err.message : String(err?.message ?? err)
    }</div>`;
    if (err instanceof ApiError && err.status === 0) setConn('error', 'offline');
  } finally {
    setBusy(false);
  }
}

/**
 * Clear the drawn answer, leaving filters and beacons untouched. Aborts any
 * in-flight request.
 */
function clearResults() {
  inflight?.abort();
  inflight = null;
  setBusy(false);

  map.clearRoutes();
  map.setUsedBeacons([]);
  map.setSelected(null);
  state.selectedId = null;

  el.resultsTitle.textContent = titleCase(state.mode);
  el.resultsBody.innerHTML = `<p class="empty-note">Cleared. Press <kbd>Run</kbd> for a new answer.</p>`;
  applyClientFilter();
}

function openResultsOnNarrow() {
  if (window.matchMedia('(max-width: 1180px)').matches) toggleDrawer(el.results, true);
}

// ---------------------------------------------------------------- drawers

function toggleDrawer(node, open) {
  const isOpen = open ?? node.dataset.open !== 'true';
  node.dataset.open = String(isOpen);
  const anyOpen =
    el.sidebar.dataset.open === 'true' || el.results.dataset.open === 'true';
  el.scrim.hidden = !anyOpen || !window.matchMedia('(max-width: 1180px)').matches;
  $('#btn-sidebar').setAttribute('aria-expanded', String(el.sidebar.dataset.open === 'true'));
  $('#btn-results').setAttribute('aria-expanded', String(el.results.dataset.open === 'true'));
}

// ---------------------------------------------------------------- events

function wire() {
  // mode switch
  document.querySelectorAll('[data-mode]').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('[data-mode]').forEach((b) =>
        b.setAttribute('aria-checked', String(b === btn)),
      );
      state.mode = btn.dataset.mode;
      el.modeHint.textContent = {
        nearest: 'Rank POIs by travel time from your unlocked beacons.',
        route: 'Click a point on the map, then Run for a leg-by-leg route.',
        tour: 'Shortest tour visiting every POI that matches your filters.',
      }[state.mode];
      el.resultsTitle.textContent = titleCase(state.mode);
    });
  });

  // filters
  el.kind.addEventListener('change', () => {
    state.kinds = [...el.kind.selectedOptions].map((o) => o.value);
    applyClientFilter();
  });
  el.biome.addEventListener('change', () => {
    state.biomes = [...el.biome.selectedOptions].map((o) => o.value);
    applyClientFilter();
  });
  $('#filters-reset').addEventListener('click', () => {
    state.kinds = [];
    state.biomes = [];
    state.levelMin = null;
    state.levelMax = null;
    state.search = '';
    for (const o of el.kind.options) o.selected = false;
    for (const o of el.biome.options) o.selected = false;
    el.levelMin.value = '';
    el.levelMax.value = '';
    el.search.value = '';
    applyClientFilter();
  });
  const numeric = (input, key) =>
    input.addEventListener('input', () => {
      const v = input.value === '' ? null : Number(input.value);
      state[key] = Number.isFinite(v) ? v : null;
      applyClientFilter();
    });
  numeric(el.levelMin, 'levelMin');
  numeric(el.levelMax, 'levelMax');
  el.search.addEventListener('input', debounce(() => {
    state.search = el.search.value;
    applyClientFilter();
  }, 180));

  el.mount.addEventListener('change', () => {
    state.mount = el.mount.value;
    updateMountHint();
  });
  el.teleport.addEventListener('input', () => {
    state.teleportCost = Number(el.teleport.value);
    el.tpValue.textContent = `${state.teleportCost} s`;
  });

  // beacons
  el.beaconSearch.addEventListener('input', debounce(renderBeaconList, 140));
  el.beaconList.addEventListener('change', (e) => {
    const cb = e.target;
    if (!(cb instanceof HTMLInputElement)) return;
    if (cb.checked) state.unlocked.add(cb.value);
    else state.unlocked.delete(cb.value);
    saveUnlocked();
    map.setUnlockedBeacons(state.unlocked);
    el.beaconCount.textContent = `${state.unlocked.size} / ${state.beacons.length}`;
  });
  $('#beacons-all').addEventListener('click', () =>
    setUnlocked(state.beacons.map((b) => b.poi_id)),
  );
  $('#beacons-none').addEventListener('click', () => setUnlocked([]));

  // display options
  el.optLabels.addEventListener('change', () => map.setOption('labels', el.optLabels.checked));
  el.optGrid.addEventListener('change', () => map.setOption('grid', el.optGrid.checked));
  el.optOffmap.addEventListener('change', () => map.setOption('offmap', el.optOffmap.checked));
  el.optAllPois.addEventListener('change', () =>
    map.setOption('unmatched', el.optAllPois.checked),
  );
  el.optBasemapOn.addEventListener('change', () => {
    map.setBaseImage(el.optBasemapOn.checked ? state.baseImage : null);
    // Enable the grid when the image is switched off.
    if (!el.optBasemapOn.checked && !el.optGrid.checked) {
      el.optGrid.checked = true;
      map.setOption('grid', true);
    }
  });

  // --- base map alignment: manual override of the derived placement --------
  const alignInputs = { scale: $('#al-scale'), x: $('#al-x'), y: $('#al-y') };
  const syncAlignUI = () => {
    alignInputs.scale.value = String(BASE_MAP.scale);
    alignInputs.x.value = String(Math.round(BASE_MAP.offsetX));
    alignInputs.y.value = String(Math.round(BASE_MAP.offsetY));
    $('#al-scale-v').textContent = BASE_MAP.scale.toFixed(4);
    $('#al-x-v').textContent = `${Math.round(BASE_MAP.offsetX)} px`;
    $('#al-y-v').textContent = `${Math.round(BASE_MAP.offsetY)} px`;
    $('#al-flipx').setAttribute('aria-pressed', String(BASE_MAP.flipX === -1));
    $('#al-flipy').setAttribute('aria-pressed', String(BASE_MAP.flipY === -1));
  };
  const applyAlign = () => {
    savePlacement({
      scale: BASE_MAP.scale,
      offsetX: BASE_MAP.offsetX,
      offsetY: BASE_MAP.offsetY,
      flipX: BASE_MAP.flipX,
      flipY: BASE_MAP.flipY,
    });
    syncAlignUI();
    // Placement feeds the projection, so rebuild it.
    map.setProjectionTransform(state.meta.map_transform);
    map.requestDraw();
  };
  alignInputs.scale.addEventListener('input', () => {
    BASE_MAP.scale = Number(alignInputs.scale.value);
    applyAlign();
  });
  alignInputs.x.addEventListener('input', () => {
    BASE_MAP.offsetX = Number(alignInputs.x.value);
    applyAlign();
  });
  alignInputs.y.addEventListener('input', () => {
    BASE_MAP.offsetY = Number(alignInputs.y.value);
    applyAlign();
  });
  $('#al-flipx').addEventListener('click', () => { BASE_MAP.flipX *= -1; applyAlign(); });
  $('#al-flipy').addEventListener('click', () => { BASE_MAP.flipY *= -1; applyAlign(); });
  $('#al-reset').addEventListener('click', () => { resetPlacement(); applyAlign(); map.fit(); });
  syncAlignUI();

  el.optOpacity.addEventListener('input', () => {
    const v = Number(el.optOpacity.value);
    el.opacityValue.textContent = `${v}%`;
    map.setBaseImageOpacity(v / 100);
  });

  el.optBasemap.addEventListener('change', () => {
    const file = el.optBasemap.files?.[0];
    if (!file) return;
    const img = new Image();
    img.onload = () => {
      state.baseImage = img;
      map.setBaseImage(img);
      el.optBasemapOn.checked = true;
      // The bundled calibration only applies to the bundled image.
      el.basemapFitNote.textContent =
        `${img.naturalWidth}x${img.naturalHeight}. Markers are placed with the ` +
        `calibration derived for the bundled 1000x1000 map — a different image ` +
        `will not line up unless it shares that framing.`;
      map.fit();
    };
    img.src = URL.createObjectURL(file);
  });

  // map controls
  $('#zoom-in').addEventListener('click', () => map.zoomBy(1.4));
  $('#zoom-out').addEventListener('click', () => map.zoomBy(1 / 1.4));
  $('#zoom-fit').addEventListener('click', () => map.fit());

  // legend toggles
  el.legend.addEventListener('click', (e) => {
    const item = e.target.closest('[data-kind]');
    if (!item) return;
    const kind = item.dataset.kind;
    const off = item.dataset.off !== 'true';
    map.toggleKind(kind, off);
    item.dataset.off = String(off);
  });

  // results -> map
  el.resultsBody.addEventListener('click', (e) => {
    const row = e.target.closest('[data-poi]');
    if (!row) return;
    const poi = state.poiById.get(row.dataset.poi);
    if (!poi) return;
    selectPoi(poi.poi_id, { focus: true });
    el.resultsBody.querySelectorAll('[data-poi]').forEach((r) =>
      r.setAttribute('data-active', String(r === row)),
    );
  });

  // run / clear
  el.run.addEventListener('click', run);
  el.clear.addEventListener('click', clearResults);
  $('#retry').addEventListener('click', boot);

  // drawers
  $('#btn-sidebar').addEventListener('click', () => toggleDrawer(el.sidebar));
  $('#btn-results').addEventListener('click', () => toggleDrawer(el.results));
  el.scrim.addEventListener('click', () => {
    toggleDrawer(el.sidebar, false);
    toggleDrawer(el.results, false);
  });

  // dismissible banner
  document.querySelectorAll('[data-dismiss]').forEach((b) =>
    b.addEventListener('click', () => {
      document.getElementById(b.dataset.dismiss).hidden = true;
    }),
  );

  // keyboard
  window.addEventListener('keydown', (e) => {
    // e.target is not always an Element.
    const el = e.target instanceof Element ? e.target : null;
    if (el?.matches('input, select, textarea')) {
      if (e.key === 'Enter') run();
      return;
    }
    if (e.key === 'Enter') run();
    if (e.key === 'f') map.fit();
    if (e.key === '+' || e.key === '=') map.zoomBy(1.4);
    if (e.key === '-') map.zoomBy(1 / 1.4);
    if (e.key === 'Escape') {
      // Shift+Esc clears; plain Esc only closes drawers.
      if (e.shiftKey) {
        clearResults();
        return;
      }
      toggleDrawer(el.sidebar, false);
      toggleDrawer(el.results, false);
    }
  });

  // scale bar follows the renderer's grid step
  const tick = () => {
    const s = map.scale;
    if (s.metres) {
      const bar = el.scalebar.querySelector('.scalebar__bar');
      const txt = el.scalebar.querySelector('.scalebar__text');
      bar.style.width = `${Math.round(s.px)}px`;
      txt.textContent = s.metres >= 1000 ? `${s.metres / 1000} km` : `${s.metres} m`;
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

function selectPoi(id, { focus = false } = {}) {
  state.selectedId = id;
  map.setSelected(id);
  if (focus) {
    const poi = state.poiById.get(id);
    if (poi) map.focusOn(poi);
  }
}

// ---------------------------------------------------------------- start

map = new MapView(el.canvas, {
  onSelect: (poi) => {
    if (!poi) {
      state.selectedId = null;
      map.setSelected(null);
      return;
    }
    selectPoi(poi.poi_id);
    // A map click switches to Route mode and runs.
    if (state.mode !== 'tour') {
      state.mode = 'route';
      document.querySelectorAll('[data-mode]').forEach((b) =>
        b.setAttribute('aria-checked', String(b.dataset.mode === 'route')),
      );
      el.resultsTitle.textContent = 'Route';
      run();
    }
  },
  onHover: (poi, at) => {
    if (!poi || !at) {
      el.tooltip.hidden = true;
      return;
    }
    el.tooltip.innerHTML = renderTooltip(poi);
    el.tooltip.hidden = false;
    const box = el.tooltip.getBoundingClientRect();
    const wrap = el.canvas.getBoundingClientRect();
    // Flip the tooltip near the right or bottom edge.
    const flipX = at.x + box.width + 24 > wrap.width;
    const flipY = at.y + box.height + 24 > wrap.height;
    el.tooltip.style.left = `${at.x}px`;
    el.tooltip.style.top = `${at.y}px`;
    el.tooltip.style.transform = `translate(${flipX ? -box.width - 12 : 12}px, ${
      flipY ? -box.height - 12 : 12
    }px)`;
  },
});

wire();
boot();

// Debug handle for the console.
window.__palroute = { map, state, api, run, boot };

// Poll while offline so the page reconnects on its own.
setInterval(async () => {
  if (el.conn.dataset.state !== 'error') return;
  try {
    await api.health();
    boot();
  } catch { /* still down */ }
}, 5000);
