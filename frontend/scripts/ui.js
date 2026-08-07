// Results-panel rendering. Surfaces everything the backend flags: estimated
// legs, teleport hops, unreachable targets and terrain tier.
import { duration, escapeHtml, titleCase } from './format.js';
import { kindColor, KIND_ORDER, modeColor } from './palette.js';

const MODE_LABEL = {
  walk: 'walk',
  fly: 'fly',
  swim: 'swim',
  teleport: 'fast travel',
  portal: 'enter',
};

function chip(mode) {
  return `<span class="chip chip--${mode}">${MODE_LABEL[mode] ?? mode}</span>`;
}

function estChip() {
  return `<span class="chip chip--est" title="This leg's cost rests on an assumption, not a modelled path.">est</span>`;
}

function poiMeta(poi) {
  const bits = [titleCase(poi.kind)];
  if (poi.biome) bits.push(poi.biome);
  if (poi.boss_level) bits.push(`lv ${poi.boss_level}`);
  return escapeHtml(bits.join(' · '));
}

/**
 * Warnings from the API envelope. The terrain-tier warning is excluded here
 * and rendered once by `renderFootnote`.
 */
export function renderNotices(warnings = []) {
  const shown = warnings.filter((w) => w.code !== 'terrain_tier_b');
  if (!shown.length) return '';
  return shown
    .map((w) => {
      const hard = w.code === 'unreachable_components';
      return `<div class="notice ${hard ? 'notice--warn' : ''}">${escapeHtml(w.message)}</div>`;
    })
    .join('');
}

/** Footnote shown once under a result. */
export function renderFootnote(note) {
  if (!note) return '';
  return `<p class="footnote">${escapeHtml(note)}</p>`;
}

/**
 * Beacons the answer uses, for map highlighting. On a tour's per-stop routes
 * `start_beacon` is the previous stop, so only the top-level one is read;
 * teleport leg endpoints are beacons by definition.
 */
export function usedBeaconsFrom(payload) {
  const ids = new Set();
  const teleportEndpoints = (r) => {
    for (const leg of r?.legs ?? []) {
      if (leg.mode === 'teleport') {
        ids.add(leg.from.poi_id);
        ids.add(leg.to.poi_id);
      }
    }
  };

  if (payload.start_beacon) ids.add(payload.start_beacon.poi_id);

  // In single-route mode start_beacon is a real beacon.
  if (payload.route?.start_beacon) ids.add(payload.route.start_beacon.poi_id);
  teleportEndpoints(payload.route);

  for (const r of payload.routes ?? []) teleportEndpoints(r);

  // In nearest mode each result names its serving beacon.
  for (const res of payload.results ?? []) {
    if (res.start_beacon) ids.add(res.start_beacon.poi_id);
  }
  return ids;
}

/** Fast-travel hops within one leg-route. */
function teleportSteps(route) {
  if (!route?.legs?.length) return [];
  return route.legs
    .filter((l) => l.mode === 'teleport')
    .map((l) => ({ from: l.from, to: l.to, seconds: l.seconds }));
}

function hopRow(step) {
  return `
    <div class="hop" data-poi="${escapeHtml(step.to.poi_id)}" tabindex="0" role="button">
      <div class="hop__glyph">⇒</div>
      <div class="hop__body">
        <div class="hop__title">Fast travel to ${escapeHtml(step.to.name)}</div>
        <div class="hop__meta">from ${escapeHtml(step.from.name)}</div>
      </div>
      <div class="hop__time">${duration(step.seconds)}</div>
    </div>`;
}

export function renderNearest(data) {
  const results = data.results ?? [];
  if (!results.length) {
    return (
      renderNotices(data.warnings) +
      `<p class="empty-note">Nothing reachable matched those filters.<br>
       Try unlocking more beacons, or widening the filters.</p>`
    );
  }

  const rows = results
    .map((r, i) => {
      // The serving beacon, shown with the hop glyph.
      const beacon = r.start_beacon
        ? `<span class="rank__beacon">⇒ ${escapeHtml(r.start_beacon.name)}</span>`
        : `<span style="color:var(--danger)">no beacon reaches this</span>`;
      return `
      <div class="rank" data-poi="${escapeHtml(r.poi.poi_id)}" tabindex="0" role="button">
        <div class="rank__num">${i + 1}</div>
        <div class="rank__body">
          <div class="rank__title">${escapeHtml(r.poi.name)}</div>
          <div class="rank__meta">${poiMeta(r.poi)} ${r.estimated ? estChip() : ''}</div>
          <div class="rank__meta">${beacon}</div>
        </div>
        <div class="rank__time">${duration(r.seconds)}</div>
      </div>`;
    })
    .join('');

  const unreachable = data.unreachable?.length
    ? `<div class="section-label">Unreachable (${data.unreachable.length})</div>` +
      data.unreachable
        .slice(0, 25)
        .map(
          (p) =>
            `<div class="rank" data-poi="${escapeHtml(p.poi_id)}" tabindex="0" role="button">
               <div class="rank__num">–</div>
               <div class="rank__body">
                 <div class="rank__title" style="color:var(--fg-faint)">${escapeHtml(p.name)}</div>
                 <div class="rank__meta">${poiMeta(p)}</div>
               </div>
             </div>`,
        )
        .join('')
    : '';

  return renderNotices(data.warnings) + rows + unreachable;
}

export function renderRoute(data) {
  const route = data.route;
  if (!route) {
    return (
      renderNotices(data.warnings) +
      `<p class="empty-note">No route to that target from your unlocked beacons.<br>
       Palworld's landmasses are genuinely disconnected — you may need a beacon on that island.</p>`
    );
  }

  const legs = route.legs ?? [];
  const summary = `
    <div class="summary">
      <div class="summary__total">${duration(route.total_seconds)}</div>
      <dl>
        <div class="summary__row"><dt>Target</dt><dd>${escapeHtml(route.target.name)}</dd></div>
        <div class="summary__row"><dt>Start beacon</dt><dd style="color:${kindColor('fast_travel')}">
          ${route.start_beacon ? escapeHtml(route.start_beacon.name) : '—'}</dd></div>
        <div class="summary__row"><dt>Legs</dt><dd>${legs.length}</dd></div>
        <div class="summary__row"><dt>Fast travel hops</dt><dd>${route.teleport_hops}</dd></div>
      </dl>
    </div>`;

  const teleportNote = route.teleport_hops
    ? `<div class="notice notice--teleport">
         This route uses ${route.teleport_hops} fast-travel hop${route.teleport_hops > 1 ? 's' : ''}.
         Doubling back to a beacon instead of continuing to the nearest point is
         expected — the teleport is genuinely faster.
       </div>`
    : '';

  const rows = legs
    .map(
      (leg, i) => `
      <div class="leg" data-poi="${escapeHtml(leg.to.poi_id)}" data-leg="${i}" tabindex="0" role="button">
        <div class="leg__num">${i + 1}</div>
        <div class="leg__body">
          <div class="leg__title">${escapeHtml(leg.to.name)}</div>
          <div class="leg__meta">
            ${chip(leg.mode)}
            ${leg.estimated ? estChip() : ''}
            <span>from ${escapeHtml(leg.from.name)}</span>
          </div>
        </div>
        <div class="leg__time">
          ${duration(leg.seconds)}
          <div style="font-size:.68rem;color:var(--fg-faint)">${duration(leg.cumulative_seconds)}</div>
        </div>
      </div>`,
    )
    .join('');

  return renderNotices(data.warnings) + summary + teleportNote + rows;
}

export function renderTour(data) {
  const stops = data.stops ?? [];
  if (!stops.length) {
    return (
      renderNotices(data.warnings) +
      `<p class="empty-note">No reachable targets matched those filters.</p>`
    );
  }

  const opt = data.optimisation ?? {};
  const saved = (opt.nearest_neighbour_seconds ?? 0) - (opt.two_opt_seconds ?? 0);
  const summary = `
    <div class="summary">
      <div class="summary__total">${duration(data.total_seconds)}</div>
      <dl>
        <div class="summary__row"><dt>Stops</dt><dd>${data.stop_count}</dd></div>
        <div class="summary__row"><dt>Start beacon</dt><dd style="color:${kindColor('fast_travel')}">
          ${data.start_beacon ? escapeHtml(data.start_beacon.name) : '—'}</dd></div>
        <div class="summary__row"><dt>Fast travel hops</dt><dd>${data.teleport_hops}</dd></div>
        <div class="summary__row"><dt>NN seed</dt><dd>${duration(opt.nearest_neighbour_seconds)}</dd></div>
        <div class="summary__row"><dt>After 2-opt</dt><dd>${duration(opt.two_opt_seconds)}</dd></div>
        <div class="summary__row"><dt>Saved</dt><dd>${saved > 0.5 ? duration(saved) : 'no gain'}</dd></div>
      </dl>
    </div>`;

  const selection = data.selection
    ? `<div class="notice">${escapeHtml(data.selection.method)}
        ${data.selection.group_count ? `<br><strong>${data.selection.group_count}</strong> groups.` : ''}
       </div>`
    : '';

  // Fast-travel hops get their own rows. routes[i] aligns with stops[i], and
  // only teleport legs are promoted.
  const routes = data.routes ?? [];
  const rows = stops
    .map((s, i) => {
      const hops = teleportSteps(routes[i]).map(hopRow).join('');
      const stopRow = `
      <div class="stop" data-poi="${escapeHtml(s.poi.poi_id)}" tabindex="0" role="button">
        <div class="stop__num">${i + 1}</div>
        <div class="stop__body">
          <div class="stop__title">${escapeHtml(s.poi.name)}</div>
          <div class="stop__meta">
            ${poiMeta(s.poi)}
            ${s.estimated ? estChip() : ''}
          </div>
        </div>
        <div class="stop__time">
          +${duration(s.leg_seconds)}
          <div style="font-size:.68rem;color:var(--fg-faint)">${duration(s.arrival_seconds)}</div>
        </div>
      </div>`;
      return hops + stopRow;
    })
    .join('');

  const unreachable = data.unreachable?.length
    ? `<div class="section-label">Unreachable (${data.unreachable.length})</div>` +
      `<div class="notice notice--warn">These matched your filters but no route exists from your
        unlocked beacons. They are reported, never silently dropped.</div>` +
      data.unreachable
        .slice(0, 25)
        .map(
          (p) =>
            `<div class="stop" data-poi="${escapeHtml(p.poi_id)}" tabindex="0" role="button">
               <div class="stop__num">–</div>
               <div class="stop__body">
                 <div class="stop__title" style="color:var(--fg-faint)">${escapeHtml(p.name)}</div>
                 <div class="stop__meta">${poiMeta(p)}</div>
               </div>
             </div>`,
        )
        .join('')
    : '';

  // The approach to the first stop, shown as step one.
  const startStep = data.start_beacon
    ? `<div class="hop hop--start" data-poi="${escapeHtml(data.start_beacon.poi_id)}" tabindex="0" role="button">
         <div class="hop__glyph">⇒</div>
         <div class="hop__body">
           <div class="hop__title">Start: fast travel to ${escapeHtml(data.start_beacon.name)}</div>
           <div class="hop__meta">then head for stop 1</div>
         </div>
       </div>`
    : '';

  return (
    renderNotices(data.warnings) + summary + selection + startStep + rows + unreachable
  );
}

/** Legend: clickable kind swatches plus the travel-mode key. */
export function renderLegend(counts, hiddenKinds) {
  const kinds = KIND_ORDER.filter((k) => counts[k]);
  const kindItems = kinds
    .map(
      (k) => `
      <div class="legend__item" data-kind="${k}" data-off="${hiddenKinds.has(k)}" role="button" tabindex="0"
           title="Click to show/hide">
        <span class="legend__swatch" style="background:${kindColor(k)}"></span>
        <span>${titleCase(k)}</span>
        <span class="legend__count">${counts[k]}</span>
      </div>`,
    )
    .join('');

  const modes = ['walk', 'fly', 'teleport', 'portal']
    .map(
      (m) => `
      <div class="legend__item" style="cursor:default">
        <span class="legend__line" style="border-top-color:${modeColor(m)};
          border-top-style:${m === 'teleport' ? 'dashed' : m === 'portal' ? 'dotted' : 'solid'}"></span>
        <span>${MODE_LABEL[m]}</span>
      </div>`,
    )
    .join('');

  return `
    <div class="legend__group">
      <div class="legend__title">Points of interest</div>
      ${kindItems}
    </div>
    <div class="legend__group">
      <div class="legend__title">Travel</div>
      ${modes}
    </div>`;
}

export function renderTooltip(poi) {
  const rows = [];
  if (poi.biome) rows.push(['Biome', poi.biome]);
  if (poi.boss_level) rows.push(['Level', poi.boss_level]);
  rows.push(['World', `${Math.round(poi.world.x)}, ${Math.round(poi.world.y)}`]);
  if (poi.world.z === null) rows.push(['Elevation', 'unknown']);

  return `
    <div class="tooltip__name">${escapeHtml(poi.name)}</div>
    <div class="tooltip__kind">
      <span class="legend__swatch" style="background:${kindColor(poi.kind)}"></span>
      ${escapeHtml(poi.kind)}
    </div>
    <div class="tooltip__rows">
      ${rows.map(([k, v]) => `<div><span>${k}</span><span>${escapeHtml(v)}</span></div>`).join('')}
    </div>
    ${poi.z_estimated ? `<div class="tooltip__hint">No source elevation — routes here ignore climb.</div>` : ''}
    <div class="tooltip__hint">Click to route here.</div>`;
}
