import fs from 'node:fs/promises';
import { PoiSchema, type Dataset, type Poi, type SourceRecord } from '../types.js';
import { loadSource, readLockfile } from './fetch.js';
import { importPakExports } from './pakExport.js';
import { newAdaptContext, SOURCES } from './sources.js';

// Assemble the unified dataset. Precedence, highest first: manual overlay >
// pak export > community.

export interface BuildDatasetOptions {
  gameVersion: string;
  /** Directory of FModel/repak JSON exports, if the user has one. */
  pakDir?: string;
  /** Path to a JSON array of Poi objects layered on top (e.g. own PalBoxes). */
  manualPath?: string;
  /** Skip lockfile hash verification (used by tests with synthetic sources). */
  verify?: boolean;
}

export interface BuildDatasetResult {
  dataset: Dataset;
  warnings: string[];
  perSource: Record<string, number>;
}

// Kinds the pipeline cannot populate, recorded on the dataset with a reason.
const DECLARED_GAPS = [
  {
    kind: 'palbox',
    reason:
      'Player-placed structure; cannot come from static extracted data. Supply ' +
      'via --manual-pois to route from your own bases.',
  },
  {
    kind: 'tower_boss',
    reason:
      'No tower-boss coordinates in the community sources. The class name ' +
      'BP_LevelObject_TowerFastTravelPoint_C is used for ALL fast travel ' +
      'points, so tower positions cannot be inferred from it.',
  },
  {
    kind: 'dungeon_boss',
    reason: 'Dungeon interiors are procedurally generated — nothing static to extract.',
  },
  { kind: 'merchant', reason: 'Not present in the fetched community sources.' },
  { kind: 'chest', reason: 'Not present in the fetched community sources.' },
  { kind: 'ore_node', reason: 'Not present in the fetched community sources.' },
];

/**
 * Collapse repeated upstream rows describing one physical POI. Matches exactly
 * on identity and coordinates; proximity is left to the validator.
 */
function collapseExactDuplicates(pois: Poi[]): { kept: Poi[]; removed: Poi[] } {
  const seen = new Map<string, Poi>();
  const removed: Poi[] = [];
  for (const p of pois) {
    const key = [
      p.kind,
      p.class_id ?? '',
      p.boss_level ?? '',
      p.level_id,
      p.world_x,
      p.world_y,
      p.world_z ?? '',
    ].join('|');
    if (seen.has(key)) removed.push(p);
    else seen.set(key, p);
  }
  return { kept: [...seen.values()], removed };
}

async function loadManual(p: string): Promise<{ pois: Poi[]; warnings: string[] }> {
  const warnings: string[] = [];
  const raw: unknown = JSON.parse(await fs.readFile(p, 'utf8'));
  const arr = Array.isArray(raw)
    ? raw
    : Array.isArray((raw as { pois?: unknown }).pois)
      ? (raw as { pois: unknown[] }).pois
      : null;
  if (!arr) {
    throw new Error(
      `Manual POI file ${p} must be a JSON array of POI objects, or an object with a "pois" array.`,
    );
  }
  const pois: Poi[] = [];
  arr.forEach((entry, i) => {
    const parsed = PoiSchema.safeParse({ ...(entry as object), source: 'manual' });
    if (!parsed.success) {
      warnings.push(
        `manual[${i}]: rejected — ${parsed.error.issues.map((x) => `${x.path.join('.')}: ${x.message}`).join('; ')}`,
      );
      return;
    }
    pois.push(parsed.data);
  });
  return { pois, warnings };
}

export async function buildDataset(
  opts: BuildDatasetOptions,
): Promise<BuildDatasetResult> {
  const ctx = newAdaptContext();
  const warnings: string[] = [];
  const perSource: Record<string, number> = {};

  // Lookups index first, so POI adapters can resolve names.
  for (const src of SOURCES.filter((s) => s.role === 'lookup')) {
    try {
      const raw = await loadSource(src, { verify: opts.verify });
      src.index?.(raw, ctx);
    } catch (err) {
      warnings.push(
        `lookup "${src.id}" unavailable (${err instanceof Error ? err.message : String(err)}); ` +
          `names will fall back to code names.`,
      );
    }
  }

  let community: Poi[] = [];
  for (const src of SOURCES.filter((s) => s.role === 'poi')) {
    const raw = await loadSource(src, { verify: opts.verify });
    const produced = src.adapt?.(raw, ctx) ?? [];
    perSource[src.id] = produced.length;
    community = community.concat(produced);
  }
  warnings.push(...ctx.warnings);

  {
    const { kept, removed } = collapseExactDuplicates(community);
    if (removed.length > 0) {
      const byKind: Record<string, number> = {};
      for (const r of removed) byKind[r.kind] = (byKind[r.kind] ?? 0) + 1;
      warnings.push(
        `deduplication: collapsed ${removed.length} exact duplicate record(s) ` +
          `(identical kind, class, level and coordinates) — ` +
          `${Object.entries(byKind)
            .map(([k, n]) => `${k}: ${n}`)
            .join(', ')}. These are repeated rows in the upstream data, not ` +
          `distinct POIs.`,
      );
      community = kept;
    }
  }

  let pak: Poi[] = [];
  if (opts.pakDir) {
    const res = await importPakExports({ dir: opts.pakDir });
    pak = res.pois;
    perSource['pak'] = pak.length;
    warnings.push(...res.warnings);
    warnings.push(
      `pak import: ${res.filesScanned} file(s), ${res.groupsFound} coordinate ` +
        `group(s), ${pak.length} POI(s) classified, ${res.unclassified} unclassified.`,
    );
  }

  let manual: Poi[] = [];
  if (opts.manualPath) {
    const res = await loadManual(opts.manualPath);
    manual = res.pois;
    perSource['manual'] = manual.length;
    warnings.push(...res.warnings);
  }

  // Later layers override earlier ones on poi_id collision.
  const byId = new Map<string, Poi>();
  for (const layer of [community, pak, manual]) {
    for (const p of layer) byId.set(p.poi_id, p);
  }
  const pois = [...byId.values()];

  const lock = await readLockfile();
  const sources: SourceRecord[] = Object.values(lock.entries).map((e) => ({
    id: e.id,
    url: e.url,
    sha256: e.sha256,
    bytes: e.bytes,
    row_count: e.row_count,
    fetched_at: e.fetched_at,
    license: e.license,
    notes: e.notes,
  }));

  const dataset: Dataset = {
    game_version: opts.gameVersion,
    generated_at: new Date().toISOString(),
    generator: 'palroute data build',
    sources,
    declared_gaps: DECLARED_GAPS,
    pois,
  };

  return { dataset, warnings, perSource };
}

export async function writeDataset(dataset: Dataset, outPath: string): Promise<void> {
  await fs.writeFile(outPath, JSON.stringify(dataset, null, 2) + '\n', 'utf8');
}

export async function readDataset(p: string): Promise<Dataset> {
  const raw: unknown = JSON.parse(await fs.readFile(p, 'utf8'));
  const { DatasetSchema } = await import('../types.js');
  return DatasetSchema.parse(raw);
}
