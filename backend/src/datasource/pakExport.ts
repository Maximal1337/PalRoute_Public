import fs from 'node:fs/promises';
import path from 'node:path';
import type { Poi, PoiKind } from '../types.js';
import { readCoords, scanJson, type RecordGroup } from './scan.js';
import { inferBiome } from './sources.js';

// Adapter for FModel / repak / UE4SS exports. Walks every .json under a
// directory, finds coordinate groups via scan.ts, then classifies each record
// by its class-name prefix.

// Class-name prefix -> kind. Order matters: TowerFastTravelPoint contains both
// "Tower" and "FastTravel" and is a fast travel point, so fast travel is first.
const CLASS_RULES: ReadonlyArray<readonly [RegExp, PoiKind]> = [
  [/UnlockMapPoint/i, 'map_unlock'],
  [/FastTravel/i, 'fast_travel'],
  [/PalBox|BaseCamp/i, 'palbox'],
  [/Effigy|Lifmunk|RelicStatue|PalEggShrine/i, 'effigy'],
  [/DungeonEntrance|Dungeon_?Enter|CaveEntrance/i, 'dungeon_entrance'],
  [/TowerBoss|Tower_?Boss|RaidBoss_?Tower/i, 'tower_boss'],
  [/DungeonBoss/i, 'dungeon_boss'],
  [/^BOSS_|_BOSS(_|$)|AlphaBoss/i, 'alpha_boss'],
  [/Merchant|Trader|Vendor/i, 'merchant'],
  [/TreasureBox|TreasureChest|Chest/i, 'chest'],
  [/OreRock|MiningRock|Ore_|PaldiumRock|Node_Ore/i, 'ore_node'],
];

export interface PakImportOptions {
  /** Directory of exported JSON. Scanned recursively. */
  dir: string;
  /** Kinds to keep. Empty = keep everything classified. */
  kinds?: PoiKind[];
  /** Max files to read, guarding against pointing at an entire export. */
  maxFiles?: number;
}

export interface PakImportResult {
  pois: Poi[];
  warnings: string[];
  filesScanned: number;
  groupsFound: number;
  unclassified: number;
}

function classify(...hints: (string | null | undefined)[]): PoiKind | null {
  const hay = hints.filter(Boolean).join(' ');
  if (!hay) return null;
  for (const [re, kind] of CLASS_RULES) {
    if (re.test(hay)) return kind;
  }
  return null;
}

/** Fields that plausibly hold a class or type name, checked case-insensitively. */
const NAME_FIELDS = [
  'class',
  'classname',
  'type',
  'name',
  'objectname',
  'blueprintclass',
  'character_id',
  'characterid',
  'spawner_id',
  'spawnerid',
  'palid',
  'rowname',
];

function nameHints(rec: Record<string, unknown>): string[] {
  const out: string[] = [];
  for (const [k, v] of Object.entries(rec)) {
    if (NAME_FIELDS.includes(k.toLowerCase()) && typeof v === 'string') out.push(v);
  }
  return out;
}

function levelHint(rec: Record<string, unknown>): number | null {
  for (const [k, v] of Object.entries(rec)) {
    if (/^(level|bosslevel|boss_level|lv)$/i.test(k)) {
      const n = Number(v);
      if (Number.isFinite(n)) return Math.trunc(n);
    }
  }
  return null;
}

async function walkJsonFiles(dir: string, limit: number): Promise<string[]> {
  const found: string[] = [];
  const stack = [dir];
  while (stack.length > 0 && found.length < limit) {
    const cur = stack.pop()!;
    let entries;
    try {
      entries = await fs.readdir(cur, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const p = path.join(cur, e.name);
      if (e.isDirectory()) stack.push(p);
      else if (e.isFile() && e.name.toLowerCase().endsWith('.json')) found.push(p);
      if (found.length >= limit) break;
    }
  }
  return found;
}

export async function importPakExports(
  opts: PakImportOptions,
): Promise<PakImportResult> {
  const maxFiles = opts.maxFiles ?? 4000;
  const files = await walkJsonFiles(opts.dir, maxFiles);
  const warnings: string[] = [];
  const pois: Poi[] = [];
  const seen = new Set<string>();
  let groupsFound = 0;
  let unclassified = 0;

  if (files.length === 0) {
    warnings.push(`No .json files found under ${opts.dir}.`);
    return { pois, warnings, filesScanned: 0, groupsFound: 0, unclassified: 0 };
  }

  const keep = new Set<PoiKind>(opts.kinds ?? []);

  for (const file of files) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(await fs.readFile(file, 'utf8'));
    } catch (err) {
      warnings.push(`${path.basename(file)}: unreadable JSON (${String(err)})`);
      continue;
    }

    const rel = path.relative(opts.dir, file);
    const scan = scanJson(parsed, `$(${rel})`);
    if (scan.groups.length === 0) continue; // most export files carry no coords
    groupsFound += scan.groups.length;

    for (const group of scan.groups as RecordGroup[]) {
      // Fallback hint for records that carry no class field of their own.
      const fileHint = path.basename(file, '.json');

      for (const rec of group.records) {
        const c = readCoords(rec, group.coords);
        if (!c) continue;
        const hints = nameHints(rec.value);
        const kind = classify(...hints, fileHint);
        if (!kind) {
          unclassified++;
          continue;
        }
        if (keep.size > 0 && !keep.has(kind)) continue;

        const label = hints[0] ?? rec.key;
        const base = `${kind}_${label}`
          .replace(/[^A-Za-z0-9]+/g, '_')
          .replace(/^_+|_+$/g, '')
          .toLowerCase();
        let id = base;
        let n = 2;
        while (seen.has(id)) id = `${base}_${n++}`;
        seen.add(id);

        pois.push({
          poi_id: id,
          kind,
          name: label.replace(/_/g, ' ').replace(/([a-z0-9])([A-Z])/g, '$1 $2').trim(),
          class_id: hints[0] ?? null,
          level_id: 'overworld',
          biome: inferBiome(...hints, fileHint),
          world_x: c.x,
          world_y: c.y,
          world_z: c.z,
          z_estimated: c.z === null,
          requires: [],
          boss_level: levelHint(rec.value),
          respawn_kind: 'unknown',
          source: `pak:${rel}#${group.path}`,
        });
      }
    }
  }

  if (pois.length === 0) {
    warnings.push(
      `Scanned ${files.length} file(s) and found ${groupsFound} coordinate ` +
        `group(s), but classified 0 POIs (${unclassified} record(s) matched no ` +
        `class rule). Add a rule to CLASS_RULES in pakExport.ts, or check that ` +
        `the export includes class/type fields.`,
    );
  }

  return {
    pois,
    warnings,
    filesScanned: files.length,
    groupsFound,
    unclassified,
  };
}
