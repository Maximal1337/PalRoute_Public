#!/usr/bin/env node
import fs from 'node:fs/promises';
import { Command, Option } from 'commander';
import { Engine, type PoiFilter, type QueryOptions } from './core/engine.js';
import { DEFAULT_HOST, DEFAULT_PORT, loadExpectations, loadProfiles } from './core/config.js';
import { POIS_PATH } from './core/paths.js';
import { clearGraphCache } from './core/cache.js';
import { buildDataset, readDataset, writeDataset } from './datasource/normalize.js';
import { fetchAllSources } from './datasource/fetch.js';
import { formatReport, validateDataset } from './datasource/validate.js';
import { POI_KINDS, type PoiKind } from './types.js';
import { nearestToJson, routeToJson, tourToJson, warningsToJson, poiToJson } from './render/json.js';
import { renderMap } from './render/map.js';
import { renderNearest, renderRoute, renderTour, setColor } from './render/text.js';

const program = new Command();

program
  .name('palroute')
  .description(
    'Static POI routing for Palworld. Fast-travel beacons are real graph edges, ' +
      'so "walk 800 m" and "teleport + walk 200 m" compete on the same units (seconds).',
  )
  .version('0.1.0')
  .option('--no-color', 'disable ANSI colour');

// --------------------------------------------------------------------------
// shared option plumbing
// --------------------------------------------------------------------------

function addQueryOptions(cmd: Command): Command {
  return cmd
    .option('--kind <kinds>', 'filter by POI kind, comma-separated')
    .option(
      '--biome <biomes>',
      'filter by biome, comma-separated ("all" disables; "(none)" selects POIs with no biome)',
    )
    .option('--level-range <MIN:MAX>', 'filter by boss level, e.g. 20:40')
    .option('--search <text>', 'substring match on name or poi_id')
    .option(
      '--unlocked-beacons <file>',
      'JSON array of unlocked beacon poi_ids. DEFAULT IS NONE, not all — a player ' +
        'with six beacons open gets a different answer than one with forty.',
    )
    .addOption(
      new Option('--mount <profile>', 'movement profile').default(undefined),
    )
    .option('--teleport-cost <seconds>', 'override teleport cost', parseFloat)
    .option('--radius <metres>', 'edge-construction radius', parseFloat)
    .option('--min-degree <n>', 'minimum neighbours per node', (v) => parseInt(v, 10))
    .option('--no-dungeon-interiors', 'skip synthesized dungeon interior layers')
    .addOption(
      new Option('--format <fmt>', 'output format')
        .choices(['text', 'json', 'map'])
        .default('text'),
    )
    .option('--out <file>', 'write output to a file instead of stdout')
    .option('--no-cache', 'force graph rebuild')
    .option('--dataset <file>', 'dataset path', POIS_PATH)
    .option('--heightmap <file>', 'Tier A heightmap sidecar (enables terrain modelling)');
}

interface RawOpts {
  kind?: string;
  biome?: string;
  levelRange?: string;
  search?: string;
  unlockedBeacons?: string;
  mount?: string;
  teleportCost?: number;
  radius?: number;
  minDegree?: number;
  dungeonInteriors?: boolean;
  format?: string;
  out?: string;
  cache?: boolean;
  dataset?: string;
  heightmap?: string;
  limit?: string;
  onePer?: string;
}

function parseKinds(raw?: string): PoiKind[] | undefined {
  if (!raw) return undefined;
  const wanted = raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const bad = wanted.filter((k) => !POI_KINDS.includes(k as PoiKind));
  if (bad.length) {
    throw new Error(
      `Unknown kind(s): ${bad.join(', ')}. Valid: ${POI_KINDS.join(', ')}`,
    );
  }
  return wanted as PoiKind[];
}

function parseLevelRange(raw?: string): { min?: number; max?: number } {
  if (!raw) return {};
  const m = /^(\d+)?:(\d+)?$/.exec(raw.trim());
  if (!m) throw new Error(`--level-range must look like MIN:MAX (got "${raw}")`);
  return {
    min: m[1] ? parseInt(m[1], 10) : undefined,
    max: m[2] ? parseInt(m[2], 10) : undefined,
  };
}

async function readBeacons(file?: string): Promise<string[]> {
  if (!file) return [];
  const raw: unknown = JSON.parse(await fs.readFile(file, 'utf8'));
  if (Array.isArray(raw)) return raw.map(String);
  if (raw && typeof raw === 'object' && Array.isArray((raw as { beacons?: unknown }).beacons)) {
    return (raw as { beacons: unknown[] }).beacons.map(String);
  }
  throw new Error(
    `${file} must be a JSON array of poi_ids, or an object with a "beacons" array.`,
  );
}

async function buildFilterAndQuery(
  o: RawOpts,
): Promise<{ filter: PoiFilter; query: QueryOptions }> {
  const lr = parseLevelRange(o.levelRange);
  const filter: PoiFilter = {
    kinds: parseKinds(o.kind),
    // Comma-separated, like --kind. "all" disables the filter.
    biomes: o.biome
      ? o.biome.split(',').map((s) => s.trim()).filter((s) => s && s !== 'all')
      : undefined,
    levelMin: lr.min,
    levelMax: lr.max,
    search: o.search,
  };
  const query: QueryOptions = {
    profile: o.mount,
    radiusMetres: o.radius,
    teleportCostSeconds: o.teleportCost,
    unlockedBeacons: await readBeacons(o.unlockedBeacons),
    dungeonInteriors: o.dungeonInteriors,
    minDegree: o.minDegree,
    noCache: o.cache === false,
  };
  return { filter, query };
}

async function emit(text: string, out?: string): Promise<void> {
  if (out) {
    await fs.writeFile(out, text.endsWith('\n') ? text : text + '\n', 'utf8');
    process.stderr.write(`written to ${out}\n`);
  } else {
    process.stdout.write(text + '\n');
  }
}

async function makeEngine(o: RawOpts): Promise<Engine> {
  return Engine.create({
    datasetPath: o.dataset,
    heightmapPath: o.heightmap,
  });
}

// --------------------------------------------------------------------------
// data
// --------------------------------------------------------------------------

const data = program.command('data').description('fetch and build the POI dataset');

data
  .command('fetch')
  .description('download community sources into data/vendor/ and refresh the lockfile')
  .option('--only <ids>', 'comma-separated source ids')
  .option(
    '--frozen',
    'verify against the committed lockfile instead of updating it; exits non-zero if upstream drifted',
  )
  .action(async (opts: { only?: string; frozen?: boolean }) => {
    const only = opts.only?.split(',').map((s) => s.trim());
    const reports = await fetchAllSources({
      ...(only ? { only } : {}),
      frozen: opts.frozen ?? false,
    });

    let failed = 0;
    let drifted = 0;
    for (const r of reports) {
      if (r.status === 'failed') {
        failed++;
        process.stderr.write(`  FAIL  ${r.id}: ${r.error}\n`);
      } else if (r.status === 'mismatch') {
        drifted++;
        process.stderr.write(
          `  DRIFT ${r.id.padEnd(28)} ${r.error}\n` +
            `        lockfile: ${r.expected ?? '(absent)'}\n` +
            `        upstream: ${r.sha256}\n`,
        );
      } else {
        process.stdout.write(
          `  ${r.status === 'fetched' ? 'GET ' : 'SAME'}  ${r.id.padEnd(28)} ` +
            `${String(r.rows).padStart(5)} rows  ${(r.bytes / 1024).toFixed(1)} KiB  ${r.sha256.slice(0, 12)}\n`,
        );
      }
    }

    const ok = reports.length - failed - drifted;
    if (drifted > 0) {
      process.stderr.write(
        `\n${drifted} source(s) no longer match the lockfile, so nothing was written.\n` +
          `Upstream is not versioned and can change at any time; the lockfile is what\n` +
          `makes a build reproducible.\n\n` +
          `To accept the new data, refresh the lockfile and review the diff:\n` +
          `  npm run data:fetch && npm run data:build && npm run validate\n` +
          `then commit data/sources.lock.json.\n`,
      );
      process.exitCode = 1;
      return;
    }

    process.stdout.write(
      `\n${ok}/${reports.length} source(s) available. ` +
        (opts.frozen ? 'Verified against the lockfile.\n' : 'Lockfile updated.\n'),
    );
    if (failed > 0) process.exitCode = 1;
  });

data
  .command('build')
  .description('normalize fetched sources into data/pois.json')
  .option('--pak-dir <dir>', 'directory of FModel/repak JSON exports (overrides community data)')
  .option('--manual-pois <file>', 'JSON array of POIs layered on top (e.g. your PalBoxes)')
  .option('--game-version <v>', 'game version string for the dataset')
  .option('--out <file>', 'output path', POIS_PATH)
  .option('--no-verify', 'skip lockfile hash verification')
  .action(
    async (opts: {
      pakDir?: string;
      manualPois?: string;
      gameVersion?: string;
      out: string;
      verify?: boolean;
    }) => {
      const exp = await loadExpectations();
      const { dataset, warnings, perSource } = await buildDataset({
        gameVersion: opts.gameVersion ?? exp.game_version,
        pakDir: opts.pakDir,
        manualPath: opts.manualPois,
        verify: opts.verify,
      });
      await writeDataset(dataset, opts.out);

      process.stdout.write(`built ${dataset.pois.length} POIs -> ${opts.out}\n`);
      for (const [k, v] of Object.entries(perSource)) {
        process.stdout.write(`  ${k.padEnd(30)} ${String(v).padStart(5)}\n`);
      }
      if (warnings.length) {
        process.stdout.write('\nnotes:\n');
        for (const w of warnings) process.stdout.write(`  - ${w}\n`);
      }
      process.stdout.write('\nNow run: palroute validate\n');
    },
  );

// --------------------------------------------------------------------------
// validate
// --------------------------------------------------------------------------

program
  .command('validate')
  .description('validate the dataset; exits non-zero on failure')
  .option('--dataset <file>', 'dataset path', POIS_PATH)
  .option('--json', 'emit the report as JSON')
  .action(async (opts: { dataset: string; json?: boolean }) => {
    const dataset = await readDataset(opts.dataset);
    const exp = await loadExpectations();
    const report = validateDataset(dataset, exp);
    if (opts.json) {
      process.stdout.write(JSON.stringify(report, null, 2) + '\n');
    } else {
      process.stdout.write(formatReport(report, { color: program.opts()['color'] !== false }) + '\n');
    }
    if (!report.ok) process.exitCode = 1;
  });

// --------------------------------------------------------------------------
// beacons
// --------------------------------------------------------------------------

program
  .command('beacons')
  .description('list every fast-travel beacon, to help build an --unlocked-beacons file')
  .option('--dataset <file>', 'dataset path', POIS_PATH)
  .option('--json', 'emit JSON array of poi_ids')
  .option('--search <text>', 'filter by name')
  .action(async (opts: { dataset: string; json?: boolean; search?: string }) => {
    const engine = await makeEngine({ dataset: opts.dataset });
    const beacons = engine
      .filterPois({ kinds: ['fast_travel', 'palbox'], search: opts.search })
      .sort((a, b) => a.name.localeCompare(b.name));
    if (opts.json) {
      process.stdout.write(JSON.stringify(beacons.map((b) => b.poi_id), null, 2) + '\n');
      return;
    }
    for (const b of beacons) {
      process.stdout.write(`${b.poi_id.padEnd(46)} ${b.name}\n`);
    }
    process.stdout.write(`\n${beacons.length} beacon(s).\n`);
  });

// --------------------------------------------------------------------------
// nearest
// --------------------------------------------------------------------------

addQueryOptions(
  program
    .command('nearest')
    .description('rank POIs by time-to-reach from your unlocked beacons')
    .option('--limit <n>', 'number of results', '10'),
).action(async (o: RawOpts) => {
  setColor(program.opts()['color'] !== false);
  const engine = await makeEngine(o);
  const { filter, query } = await buildFilterAndQuery(o);
  const limit = parseInt(o.limit ?? '10', 10);
  const { graph, reachable, unreachable, warnings } = await engine.nearest(filter, query, limit);

  if (o.format === 'json') {
    await emit(JSON.stringify(nearestToJson(reachable, unreachable, graph, warnings), null, 2), o.out);
    return;
  }
  if (o.format === 'map') {
    throw new Error('--format map applies to `to` and `tour`, not `nearest`.');
  }
  await emit(renderNearest(reachable, unreachable, graph, warnings), o.out);
});

// --------------------------------------------------------------------------
// to
// --------------------------------------------------------------------------

addQueryOptions(
  program
    .command('to')
    .argument('<poi_id>', 'target POI id')
    .description('fastest route to one POI, with the beacon you should start from'),
).action(async (poiId: string, o: RawOpts) => {
  setColor(program.opts()['color'] !== false);
  const engine = await makeEngine(o);
  const { query } = await buildFilterAndQuery(o);
  const { graph, route, warnings } = await engine.routeTo(poiId, query);

  if (o.format === 'json') {
    await emit(
      JSON.stringify(
        { route: routeToJson(route), warnings: warningsToJson(warnings) },
        null,
        2,
      ),
      o.out,
    );
    return;
  }
  if (o.format === 'map') {
    const exp = await loadExpectations();
    const rendered = renderMap({ route }, exp);
    process.stderr.write(
      `transform ${rendered.transform.model}: ` +
        `in-sample max residual ${rendered.transform.max_fit_residual.toFixed(3)} map units; ` +
        (rendered.transform.holdout.performed
          ? `leave-one-out max ${rendered.transform.holdout.max_residual!.toFixed(3)}\n`
          : `hold-out NOT performed (${rendered.transform.holdout.reason})\n`),
    );
    await emit(rendered.svg, o.out);
    return;
  }
  await emit(renderRoute(route, graph, warnings), o.out);
});

// --------------------------------------------------------------------------
// tour
// --------------------------------------------------------------------------

addQueryOptions(
  program
    .command('tour')
    .description('shortest tour visiting every matching POI')
    .addOption(
      new Option(
        '--one-per <field>',
        'visit one representative per group (greedy GTSP simplification)',
      ).choices(['class_id', 'kind']),
    )
    .option('--with-routes', 'include full leg-by-leg paths between stops'),
).action(async (o: RawOpts & { withRoutes?: boolean }) => {
  setColor(program.opts()['color'] !== false);
  const engine = await makeEngine(o);
  const { filter, query } = await buildFilterAndQuery(o);
  const needRoutes = o.withRoutes || o.format === 'map';
  const { graph, result, warnings, selectionMethod, groupCount } = await engine.tour(
    filter,
    query,
    { onePer: o.onePer as 'class_id' | 'kind' | undefined, withRoutes: needRoutes },
  );

  if (o.format === 'json') {
    await emit(
      JSON.stringify(tourToJson(result, graph, warnings, { selectionMethod, groupCount }), null, 2),
      o.out,
    );
    return;
  }
  if (o.format === 'map') {
    const exp = await loadExpectations();
    const rendered = renderMap({ tour: result }, exp);
    process.stderr.write(
      `transform ${rendered.transform.model}: ` +
        `in-sample max residual ${rendered.transform.max_fit_residual.toFixed(3)} map units; ` +
        (rendered.transform.holdout.performed
          ? `leave-one-out max ${rendered.transform.holdout.max_residual!.toFixed(3)}\n`
          : `hold-out NOT performed (${rendered.transform.holdout.reason})\n`),
    );
    await emit(rendered.svg, o.out);
    return;
  }
  await emit(renderTour(result, graph, warnings, { selectionMethod, groupCount }), o.out);
});

// --------------------------------------------------------------------------
// misc
// --------------------------------------------------------------------------

program
  .command('profiles')
  .description('list movement profiles and their provenance')
  .action(async () => {
    const p = await loadProfiles();
    process.stdout.write(`default: ${p.default_profile}\n`);
    process.stdout.write(`teleport cost: ${p.teleport_cost_seconds}s, map open: ${p.map_open_cost_seconds}s\n\n`);
    for (const prof of p.profiles) {
      process.stdout.write(
        `${prof.name.padEnd(10)} ground ${String(prof.v_ground).padStart(5)} m/s  ` +
          `${prof.can_fly ? `fly ${String(prof.v_mount).padStart(5)} m/s` : 'no flight    '}  ` +
          `[${prof.speed_source}]\n    ${prof.description}\n`,
      );
    }
    process.stdout.write(
      '\nNOTE: speeds marked estimate-unverified are order-of-magnitude guesses, ' +
        'not extracted or measured. Relative comparisons are far more trustworthy ' +
        'than absolute ETAs.\n',
    );
  });

program
  .command('info')
  .description('dataset provenance and declared gaps')
  .option('--dataset <file>', 'dataset path', POIS_PATH)
  .option('--json', 'emit JSON')
  .action(async (opts: { dataset: string; json?: boolean }) => {
    const engine = await makeEngine({ dataset: opts.dataset });
    const info = engine.datasetInfo;
    if (opts.json) {
      process.stdout.write(JSON.stringify(info, null, 2) + '\n');
      return;
    }
    process.stdout.write(`game version : ${info.game_version}\n`);
    process.stdout.write(`generated    : ${info.generated_at}\n`);
    process.stdout.write(`POIs         : ${info.poiCount}\n`);
    process.stdout.write(`terrain      : ${engine.terrainDescription}\n\n`);
    process.stdout.write('sources:\n');
    for (const s of info.sources) {
      process.stdout.write(`  ${s.id.padEnd(28)} ${String(s.row_count).padStart(5)} rows  ${s.license}\n`);
      process.stdout.write(`    ${s.url}\n`);
    }
    if (info.declared_gaps.length) {
      process.stdout.write('\ndeclared gaps (kinds this dataset cannot supply):\n');
      for (const g of info.declared_gaps) {
        process.stdout.write(`  ${g.kind}: ${g.reason}\n`);
      }
    }
  });

program
  .command('cache-clear')
  .description('delete cached graphs')
  .action(async () => {
    const n = await clearGraphCache();
    process.stdout.write(`removed ${n} cached graph(s)\n`);
  });

program
  .command('serve')
  .description('start the HTTP API for a local frontend')
  .option('--port <n>', 'port', String(DEFAULT_PORT))
  .option('--host <h>', 'host', DEFAULT_HOST)
  .option('--dataset <file>', 'dataset path', POIS_PATH)
  .option('--heightmap <file>', 'Tier A heightmap sidecar')
  .action(async (opts: { port: string; host: string; dataset: string; heightmap?: string }) => {
    const { startServer } = await import('./api/server.js');
    await startServer({
      port: parseInt(opts.port, 10),
      host: opts.host,
      datasetPath: opts.dataset,
      heightmapPath: opts.heightmap,
    });
  });

program.parseAsync(process.argv).catch((err: unknown) => {
  process.stderr.write(`\nerror: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exitCode = 1;
});
