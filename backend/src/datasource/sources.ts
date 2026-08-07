import type { Poi, PoiKind, RespawnKind } from '../types.js';
import { largestGroup, readCoords, scanJson, type RecordGroup } from './scan.js';

// Source registry: origin, license and adapter for each upstream file.
// Adapters read records through scan.ts rather than by field name.

const PSP_RAW = 'https://raw.githubusercontent.com/oMaN-Rod/palworld-save-pal/main/data/json';

/** Lookup tables built from localization sources, keyed by id. */
export interface AdaptContext {
  /** GUID -> localized fast-travel point name. */
  ftNames: Map<string, string>;
  /** Pal code name (BOSS_ stripped) -> localized Pal name. */
  palNames: Map<string, string>;
  warnings: string[];
}

export interface SourceDefinition {
  id: string;
  url: string;
  license: string;
  notes: string;
  /** Lookup sources contribute names, not POIs. */
  role: 'poi' | 'lookup';
  /** Populate ctx from a lookup source. */
  index?: (raw: unknown, ctx: AdaptContext) => void;
  /** Emit POIs from a POI source. */
  adapt?: (raw: unknown, ctx: AdaptContext) => Poi[];
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/** `IceHorse_Dark` -> `Ice Horse Dark`. Fallback when no localized name exists. */
function humanizeCode(code: string): string {
  return code
    .replace(/^BOSS_/i, '')
    .replace(/_/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/\s+/g, ' ')
    .trim();
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

function int(v: unknown): number | null {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

// Biome inferred from spawner ids like `yamijima_IceLand_pink_D_BOSS`.
// Sources carrying no hint keep biome = null.
const BIOME_TOKENS: ReadonlyArray<readonly [RegExp, string]> = [
  [/iceland|snow|ice(?![a-z])|frost|tundra/i, 'snow'],
  [/volcano|volcanic|volcanoiskand|lava|magma/i, 'volcano'],
  [/desert|sand|dune/i, 'desert'],
  [/sakura|cherry/i, 'sakura'],
  [/skyisland|sky(?![a-z])/i, 'sky'],
  [/worldtree|tree(?![a-z])/i, 'worldtree'],
  [/sanctuary/i, 'sanctuary'],
  [/remainsisland|remains|ruin/i, 'ruins'],
  [/beach|coast|shore/i, 'beach'],
  [/marsh|swamp|bog/i, 'marsh'],
  [/forest|wood|jungle/i, 'forest'],
  [/plateau|highland/i, 'plateau'],
  [/rock|mountain|cliff/i, 'mountain'],
  [/grass|plain|field/i, 'grassland'],
];

export function inferBiome(...hints: (string | null | undefined)[]): string | null {
  const hay = hints.filter(Boolean).join(' ');
  if (!hay) return null;
  for (const [re, biome] of BIOME_TOKENS) {
    if (re.test(hay)) return biome;
  }
  return null;
}

/** Stable, collision-resistant id. */
function makeId(kind: PoiKind, key: string): string {
  const clean = key.replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '').toLowerCase();
  return `${kind}_${clean || 'unknown'}`;
}

function ensureUnique(id: string, seen: Set<string>): string {
  if (!seen.has(id)) {
    seen.add(id);
    return id;
  }
  let n = 2;
  while (seen.has(`${id}_${n}`)) n++;
  const out = `${id}_${n}`;
  seen.add(out);
  return out;
}

/** Run the scanner and pick the record group, throwing when none is found. */
function groupOrThrow(raw: unknown, sourceId: string): RecordGroup {
  const scan = scanJson(raw, `$(${sourceId})`);
  const group = largestGroup(scan);
  if (!group) {
    throw new Error(
      `Scanner found no coordinate-bearing records in source "${sourceId}". ` +
        scan.diagnostics.join(' '),
    );
  }
  return group;
}

interface BuildArgs {
  kind: PoiKind;
  name: string;
  classId?: string | null;
  biome?: string | null;
  bossLevel?: number | null;
  respawn?: RespawnKind;
  levelId?: string;
  requires?: string[];
}

function buildPoi(
  args: BuildArgs,
  coords: { x: number; y: number; z: number | null },
  key: string,
  source: string,
  seen: Set<string>,
): Poi {
  return {
    poi_id: ensureUnique(makeId(args.kind, key), seen),
    kind: args.kind,
    name: args.name,
    class_id: args.classId ?? null,
    level_id: args.levelId ?? 'overworld',
    biome: args.biome ?? null,
    world_x: coords.x,
    world_y: coords.y,
    world_z: coords.z,
    z_estimated: coords.z === null,
    requires: args.requires ?? [],
    boss_level: args.bossLevel ?? null,
    respawn_kind: args.respawn ?? 'unknown',
    source,
  };
}

// ---------------------------------------------------------------------------
// sources
// ---------------------------------------------------------------------------

export const SOURCES: SourceDefinition[] = [
  // ---- lookups (names only) --------------------------------------------
  {
    id: 'psp_l10n_fast_travel_en',
    url: `${PSP_RAW}/l10n/en/fast_travel_points.json`,
    license: 'unlicensed-upstream',
    notes: 'English names for fast travel points, keyed by the same GUID as psp_fast_travel_points.',
    role: 'lookup',
    index(raw, ctx) {
      if (!raw || typeof raw !== 'object') return;
      for (const [guid, v] of Object.entries(raw as Record<string, unknown>)) {
        const name = str((v as Record<string, unknown> | null)?.['localized_name']);
        if (name) ctx.ftNames.set(guid, name);
      }
    },
  },
  {
    id: 'psp_l10n_pals_en',
    url: `${PSP_RAW}/l10n/en/pals.json`,
    license: 'unlicensed-upstream',
    notes: 'English Pal names, keyed by code name with no BOSS_ prefix.',
    role: 'lookup',
    index(raw, ctx) {
      if (!raw || typeof raw !== 'object') return;
      for (const [code, v] of Object.entries(raw as Record<string, unknown>)) {
        const name = str((v as Record<string, unknown> | null)?.['localized_name']);
        if (name) ctx.palNames.set(code.toLowerCase(), name);
      }
    },
  },

  // ---- POI sources ------------------------------------------------------
  {
    id: 'psp_fast_travel_points',
    url: `${PSP_RAW}/fast_travel_points.json`,
    license: 'unlicensed-upstream',
    notes:
      'Fast travel statues and map-unlock obelisks. Split by `class`: only ' +
      'TowerFastTravelPoint entries are real teleport endpoints.',
    role: 'poi',
    adapt(raw, ctx) {
      const group = groupOrThrow(raw, 'psp_fast_travel_points');
      const seen = new Set<string>();
      const out: Poi[] = [];
      let unknownClass = 0;

      for (const rec of group.records) {
        const c = readCoords(rec, group.coords);
        if (!c) continue;
        const cls = str(rec.value['class']) ?? 'unknown';
        const localId = str(rec.value['id']) ?? rec.key;
        const localized = ctx.ftNames.get(rec.key);

        // UnlockMapPoint reveals fog of war and does not teleport.
        let kind: PoiKind;
        if (/UnlockMapPoint/i.test(cls)) kind = 'map_unlock';
        else if (/FastTravelPoint/i.test(cls)) kind = 'fast_travel';
        else {
          unknownClass++;
          kind = 'map_unlock'; // conservative: never fabricate a teleport
        }

        out.push(
          buildPoi(
            {
              kind,
              name: localized ?? humanizeCode(localId),
              classId: cls,
              biome: inferBiome(localized),
              respawn: 'static',
            },
            c,
            localId,
            'community:palworld-save-pal/fast_travel_points.json',
            seen,
          ),
        );
      }

      if (unknownClass > 0) {
        ctx.warnings.push(
          `psp_fast_travel_points: ${unknownClass} record(s) had an unrecognised ` +
            `\`class\`; classified as map_unlock so they are excluded from the ` +
            `teleport clique. Review if a patch added a new fast-travel class.`,
        );
      }
      return out;
    },
  },

  {
    id: 'psp_effigies',
    url: `${PSP_RAW}/effigies.json`,
    license: 'unlicensed-upstream',
    notes: 'Lifmunk effigy positions. Coordinates only, no metadata.',
    role: 'poi',
    adapt(raw) {
      const group = groupOrThrow(raw, 'psp_effigies');
      const seen = new Set<string>();
      const out: Poi[] = [];
      let n = 1;
      for (const rec of group.records) {
        const c = readCoords(rec, group.coords);
        if (!c) continue;
        out.push(
          buildPoi(
            {
              kind: 'effigy',
              name: `Lifmunk Effigy #${n}`,
              // This source carries no biome hint.
              biome: null,
              respawn: 'once',
            },
            c,
            rec.key,
            'community:palworld-save-pal/effigies.json',
            seen,
          ),
        );
        n++;
      }
      return out;
    },
  },

  {
    id: 'psp_bosses',
    url: `${PSP_RAW}/bosses.json`,
    license: 'unlicensed-upstream',
    notes:
      'Boss spawners. Rows whose character_id is the literal "None" are ' +
      'human/NPC bosses, not alpha Pals, and are emitted as field_boss.',
    role: 'poi',
    adapt(raw, ctx) {
      const group = groupOrThrow(raw, 'psp_bosses');
      const seen = new Set<string>();
      const out: Poi[] = [];
      let unnamed = 0;

      for (const rec of group.records) {
        const c = readCoords(rec, group.coords);
        if (!c) continue;

        const charId = str(rec.value['character_id']);
        const spawnerId = str(rec.value['spawner_id']) ?? rec.key;
        const level = int(rec.value['level']);

        // "None" marks a human boss rather than a Pal.
        const isPal = charId !== null && charId.toLowerCase() !== 'none';

        if (isPal) {
          const code = charId.replace(/^BOSS_/i, '');
          const localized = ctx.palNames.get(code.toLowerCase());
          if (!localized) unnamed++;
          out.push(
            buildPoi(
              {
                kind: 'alpha_boss',
                name: localized ?? humanizeCode(code),
                classId: charId,
                biome: inferBiome(spawnerId),
                bossLevel: level,
                respawn: 'timed',
              },
              c,
              spawnerId,
              'community:palworld-save-pal/bosses.json',
              seen,
            ),
          );
        } else {
          out.push(
            buildPoi(
              {
                kind: 'field_boss',
                name: humanizeCode(spawnerId),
                classId: null,
                biome: inferBiome(spawnerId),
                bossLevel: level,
                respawn: 'timed',
              },
              c,
              spawnerId,
              'community:palworld-save-pal/bosses.json',
              seen,
            ),
          );
        }
      }

      if (unnamed > 0) {
        ctx.warnings.push(
          `psp_bosses: ${unnamed} alpha boss(es) had no entry in the Pal name ` +
            `lookup; fell back to a humanised code name.`,
        );
      }
      return out;
    },
  },

  {
    id: 'psp_map_objects',
    url: `${PSP_RAW}/map_objects.json`,
    license: 'unlicensed-upstream',
    notes:
      'Dungeon entrances and predator Pals. This file has NO z coordinate — ' +
      'every POI from it is flagged z_estimated. alpha_pal rows are dropped ' +
      'because psp_bosses covers the same spawns with z and level.',
    role: 'poi',
    adapt(raw, ctx) {
      const group = groupOrThrow(raw, 'psp_map_objects');
      const seen = new Set<string>();
      const out: Poi[] = [];
      let droppedAlpha = 0;
      const counters: Record<string, number> = {};

      for (const rec of group.records) {
        const c = readCoords(rec, group.coords);
        if (!c) continue;
        const type = (str(rec.value['type']) ?? '').toLowerCase();
        const pal = str(rec.value['pal']);

        // Covered by psp_bosses, which also carries z and level.
        if (type === 'alpha_pal') {
          droppedAlpha++;
          continue;
        }

        let kind: PoiKind;
        let name: string;
        if (type === 'dungeon') {
          kind = 'dungeon_entrance';
          counters['dungeon'] = (counters['dungeon'] ?? 0) + 1;
          name = `Dungeon Entrance #${counters['dungeon']}`;
        } else if (type === 'predator_pal') {
          kind = 'predator';
          const localized = pal ? ctx.palNames.get(pal.toLowerCase()) : null;
          name = localized ?? (pal ? humanizeCode(pal) : 'Predator Pal');
        } else {
          continue;
        }

        out.push(
          buildPoi(
            {
              kind,
              name,
              classId: pal,
              biome: null,
              respawn: kind === 'predator' ? 'timed' : 'static',
            },
            c,
            `${type}_${rec.key}`,
            'community:palworld-save-pal/map_objects.json',
            seen,
          ),
        );
      }

      ctx.warnings.push(
        `psp_map_objects: no z coordinate in this source; ${out.length} POI(s) ` +
          `flagged z_estimated (climb/glide term dropped, touching edges marked ` +
          `estimated). Dropped ${droppedAlpha} alpha_pal row(s) in favour of ` +
          `psp_bosses, which carries z and level.`,
      );
      return out;
    },
  },
];

export function sourceById(id: string): SourceDefinition | undefined {
  return SOURCES.find((s) => s.id === id);
}

export function newAdaptContext(): AdaptContext {
  return { ftNames: new Map(), palNames: new Map(), warnings: [] };
}
