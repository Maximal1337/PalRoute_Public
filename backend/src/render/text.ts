import type { EngineWarning } from '../core/engine.js';
import type { Graph, Route, TourResult } from '../types.js';
import type { NearestResult } from '../solve/dijkstra.js';

// Terminal output. Teleport legs get their own glyph, colour and label;
// estimated legs are marked with `[est]`.

let useColor = true;
export function setColor(on: boolean): void {
  useColor = on;
}

const c = {
  reset: () => (useColor ? '\x1b[0m' : ''),
  bold: (s: string) => (useColor ? `\x1b[1m${s}\x1b[0m` : s),
  dim: (s: string) => (useColor ? `\x1b[2m${s}\x1b[0m` : s),
  cyan: (s: string) => (useColor ? `\x1b[36m${s}\x1b[0m` : s),
  yellow: (s: string) => (useColor ? `\x1b[33m${s}\x1b[0m` : s),
  red: (s: string) => (useColor ? `\x1b[31m${s}\x1b[0m` : s),
  green: (s: string) => (useColor ? `\x1b[32m${s}\x1b[0m` : s),
  magenta: (s: string) => (useColor ? `\x1b[35m${s}\x1b[0m` : s),
};

export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds)) return 'unreachable';
  const s = Math.round(seconds);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  if (m < 60) return rem === 0 ? `${m}m` : `${m}m ${rem}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

const MODE_GLYPH: Record<string, string> = {
  walk: '·',
  fly: '~',
  swim: '≈',
  teleport: '⇒',
  portal: '▼',
};

function modeLabel(mode: string): string {
  switch (mode) {
    case 'teleport':
      return c.magenta('FAST TRAVEL');
    case 'portal':
      return c.cyan('ENTER');
    case 'fly':
      return c.green('fly');
    case 'swim':
      return c.cyan('swim');
    default:
      return c.dim('walk');
  }
}

export function renderBanner(warnings: EngineWarning[]): string {
  if (warnings.length === 0) return '';
  const lines: string[] = [];
  for (const w of warnings) {
    const isHard = w.code === 'terrain_tier_b' || w.code === 'isolated_nodes';
    const tag = isHard ? c.yellow('!!') : c.dim('..');
    const body = isHard ? c.yellow(w.message) : c.dim(w.message);
    lines.push(`${tag} ${body}`);
  }
  return lines.join('\n') + '\n';
}

export function renderGraphMeta(g: Graph): string {
  const m = g.meta;
  const estPct = m.edgeCount === 0 ? 0 : (m.estimatedEdgeCount / m.edgeCount) * 100;
  return c.dim(
    `graph: ${g.nodes.length} nodes, ${m.edgeCount} edges ` +
      `(${estPct.toFixed(0)}% estimated), terrain Tier ${m.terrainTier}, ` +
      `profile ${m.profile}, radius ${m.radiusMetres} m, ` +
      `teleport ${m.teleportCost}s, ${m.unlockedBeacons.length} beacon(s) unlocked`,
  );
}

export function renderRoute(route: Route | null, graph: Graph, warnings: EngineWarning[]): string {
  const out: string[] = [];
  const banner = renderBanner(warnings);
  if (banner) out.push(banner);

  if (!route) {
    out.push(c.red('No route found.'));
    out.push(
      c.dim(
        'The target is not reachable from any unlocked beacon. Supply more ' +
          'beacons, or check that the target is on a connected layer.',
      ),
    );
    return out.join('\n');
  }

  out.push(
    c.bold(`Route to ${route.target.name}`) +
      c.dim(` (${route.target.poi_id}, ${route.target.kind})`),
  );
  out.push(
    `Start from: ${route.startBeacon ? c.magenta(route.startBeacon.name) : c.red('no beacon — travelling from the target itself')}`,
  );
  out.push(`Total: ${c.bold(formatDuration(route.totalSeconds))}`);
  if (route.teleportHops > 0) {
    out.push(c.magenta(`Includes ${route.teleportHops} fast-travel hop(s).`));
  }
  out.push('');

  if (route.legs.length === 0) {
    out.push(c.dim('  (already at the target)'));
  }

  route.legs.forEach((leg, i) => {
    const glyph = MODE_GLYPH[leg.mode] ?? '·';
    const num = String(i + 1).padStart(2);
    const est = leg.estimated ? c.yellow(' [est]') : '';
    const head = `${num}. ${glyph} ${modeLabel(leg.mode)}  ${leg.from.name} → ${c.bold(leg.to.name)}`;
    out.push(head);
    out.push(
      c.dim(
        `      ${formatDuration(leg.seconds).padEnd(9)} cumulative ${formatDuration(leg.cumulativeSeconds)}`,
      ) + est,
    );
    if (leg.note) out.push(c.dim(`      ${leg.note}`));
  });

  out.push('');
  if (route.anyEstimated) {
    out.push(c.yellow('[est] = leg cost rests on an assumption, not a modelled path.'));
  }
  out.push(renderGraphMeta(graph));
  return out.join('\n');
}

export function renderNearest(
  reachable: NearestResult[],
  unreachable: { name: string; poi_id: string }[],
  graph: Graph,
  warnings: EngineWarning[],
): string {
  const out: string[] = [];
  const banner = renderBanner(warnings);
  if (banner) out.push(banner);

  if (reachable.length === 0) {
    out.push(c.red('Nothing reachable matched that filter.'));
  } else {
    out.push(c.bold(`${reachable.length} nearest target(s)`));
    out.push('');
    const nameW = Math.min(Math.max(...reachable.map((r) => r.poi.name.length), 4), 34);
    reachable.forEach((r, i) => {
      const est = r.anyEstimated ? c.yellow(' [est]') : '';
      const via = r.startBeacon
        ? c.magenta(r.startBeacon.name)
        : c.red('no beacon');
      out.push(
        `${String(i + 1).padStart(2)}. ${r.poi.name.padEnd(nameW).slice(0, nameW)}  ` +
          `${formatDuration(r.seconds).padStart(9)}  ${c.dim('from')} ${via}${est}`,
      );
      out.push(c.dim(`    ${r.poi.poi_id}  ${r.poi.kind}${r.poi.biome ? ` · ${r.poi.biome}` : ''}${r.poi.boss_level ? ` · lv ${r.poi.boss_level}` : ''}`));
    });
  }

  if (unreachable.length > 0) {
    out.push('');
    out.push(c.yellow(`${unreachable.length} matching POI(s) unreachable:`));
    for (const u of unreachable.slice(0, 10)) out.push(c.dim(`  - ${u.name} (${u.poi_id})`));
    if (unreachable.length > 10) out.push(c.dim(`  ... and ${unreachable.length - 10} more`));
  }

  out.push('');
  out.push(renderGraphMeta(graph));
  return out.join('\n');
}

export function renderTour(
  result: TourResult,
  graph: Graph,
  warnings: EngineWarning[],
  extra: { selectionMethod?: string; groupCount?: number } = {},
): string {
  const out: string[] = [];
  const banner = renderBanner(warnings);
  if (banner) out.push(banner);

  if (result.stops.length === 0) {
    out.push(c.red('No reachable targets matched that filter.'));
    if (result.unreachable.length) {
      out.push(c.yellow(`${result.unreachable.length} target(s) unreachable.`));
    }
    return out.join('\n');
  }

  out.push(c.bold(`Tour of ${result.stops.length} target(s)`));
  out.push(
    `Start from: ${result.startBeacon ? c.magenta(result.startBeacon.name) : c.red('no beacon')}`,
  );
  out.push(`Total: ${c.bold(formatDuration(result.totalSeconds))}`);
  const saved = result.seedSeconds - result.improvedSeconds;
  out.push(
    c.dim(
      `nearest-neighbour seed ${formatDuration(result.seedSeconds)} → ` +
        `2-opt ${formatDuration(result.improvedSeconds)} ` +
        `(${saved > 0.5 ? `saved ${formatDuration(saved)}` : 'no improvement'}, ` +
        `${result.twoOptIterations} pass(es))`,
    ),
  );
  if (extra.selectionMethod) {
    out.push(c.dim(`selection: ${extra.selectionMethod}`));
    if (extra.groupCount !== undefined) out.push(c.dim(`groups: ${extra.groupCount}`));
  }
  out.push('');

  const totalHops = result.stops.reduce((n, s) => n + s.teleportHops, 0);
  const nameW = Math.min(Math.max(...result.stops.map((s) => s.poi.name.length), 4), 34);

  result.stops.forEach((s, i) => {
    const hop = s.teleportHops > 0 ? c.magenta(` ⇒×${s.teleportHops}`) : '';
    const est = s.estimated ? c.yellow(' [est]') : '';
    out.push(
      `${String(i + 1).padStart(3)}. ${s.poi.name.padEnd(nameW).slice(0, nameW)}  ` +
        `+${formatDuration(s.legSeconds).padStart(8)}  ` +
        `${c.dim('@')} ${formatDuration(s.arrivalSeconds).padStart(9)}${hop}${est}`,
    );
  });

  out.push('');
  if (totalHops > 0) {
    out.push(
      c.magenta(
        `⇒ ${totalHops} fast-travel hop(s) across the tour. Routing back to a ` +
          `beacon instead of continuing to the next-closest target is expected ` +
          `behaviour, not a bug — the teleport is genuinely faster.`,
      ),
    );
  }
  if (result.unreachable.length > 0) {
    out.push(c.yellow(`${result.unreachable.length} target(s) unreachable and excluded:`));
    for (const u of result.unreachable.slice(0, 10)) {
      out.push(c.dim(`  - ${u.name} (${u.poi_id})`));
    }
    if (result.unreachable.length > 10) {
      out.push(c.dim(`  ... and ${result.unreachable.length - 10} more`));
    }
  }

  out.push('');
  out.push(renderGraphMeta(graph));
  return out.join('\n');
}
