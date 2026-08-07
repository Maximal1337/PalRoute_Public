import { z } from 'zod';

// POI kinds.
export const POI_KINDS = [
  'fast_travel',
  'palbox',
  'alpha_boss',
  'tower_boss',
  'dungeon_entrance',
  'dungeon_boss',
  'effigy',
  'merchant',
  'chest',
  'ore_node',

  /** Fog-of-war reveals. Excluded from the teleport clique. */
  'map_unlock',
  /** Human/NPC world bosses, not Pals. */
  'field_boss',
  /** Predator Pals. Distinct spawn class from alphas. */
  'predator',
] as const;

export type PoiKind = (typeof POI_KINDS)[number];

/** Kinds that act as zero-ish-cost teleport endpoints when unlocked. */
export const TELEPORT_KINDS: readonly PoiKind[] = ['fast_travel', 'palbox'];

export const RespawnKind = z.enum(['timed', 'once', 'static', 'unknown']);
export type RespawnKind = z.infer<typeof RespawnKind>;

/**
 * Unified node schema. A null `world_z` with `z_estimated` makes the cost model
 * drop the climb/glide term and flag every touching edge.
 */
export const PoiSchema = z.object({
  poi_id: z.string().min(1),
  kind: z.enum(POI_KINDS),
  name: z.string().min(1),
  class_id: z.string().nullable().default(null),
  level_id: z.string().min(1).default('overworld'),
  biome: z.string().nullable().default(null),
  world_x: z.number().finite(),
  world_y: z.number().finite(),
  world_z: z.number().finite().nullable(),
  /** True when world_z was absent in the source and substituted with 0. */
  z_estimated: z.boolean().default(false),
  requires: z.array(z.string()).default([]),
  boss_level: z.number().int().nullable().default(null),
  respawn_kind: RespawnKind.default('unknown'),
  source: z.string().min(1),
});

export type Poi = z.infer<typeof PoiSchema>;

/** Provenance for one fetched upstream file. */
export const SourceRecordSchema = z.object({
  id: z.string(),
  url: z.string().url(),
  sha256: z.string().length(64),
  bytes: z.number().int().nonnegative(),
  row_count: z.number().int().nonnegative(),
  fetched_at: z.string(),
  license: z.string(),
  notes: z.string().default(''),
});
export type SourceRecord = z.infer<typeof SourceRecordSchema>;

export const DatasetSchema = z.object({
  /** Game patch this dataset describes. A mismatch warns rather than fails. */
  game_version: z.string(),
  generated_at: z.string(),
  generator: z.string(),
  sources: z.array(SourceRecordSchema),
  /** Kinds this dataset cannot supply, with the reason. */
  declared_gaps: z.array(
    z.object({ kind: z.string(), reason: z.string() }),
  ).default([]),
  pois: z.array(PoiSchema),
});
export type Dataset = z.infer<typeof DatasetSchema>;

// ---------------------------------------------------------------------------
// Graph
// ---------------------------------------------------------------------------

export type EdgeMode = 'walk' | 'fly' | 'swim' | 'teleport' | 'portal';

export interface Edge {
  /** Index into Graph.nodes. */
  from: number;
  to: number;
  /** Seconds. Never metres. */
  weight: number;
  mode: EdgeMode;
  /** Weight rests on an assumption: Tier B terrain, null Z, a portal constant, or a fallback link. */
  estimated: boolean;
  /** Why it is estimated / flagged. Surfaced in output. */
  note?: string;
}

export interface Graph {
  nodes: Poi[];
  /** Adjacency list, indexed the same as `nodes`. */
  adj: Edge[][];
  /** poi_id -> node index. */
  index: Map<string, number>;
  meta: {
    terrainTier: 'A' | 'B';
    profile: string;
    teleportCost: number;
    radiusMetres: number;
    unlockedBeacons: string[];
    edgeCount: number;
    /** Number of edges flagged estimated. */
    estimatedEdgeCount: number;
    longFallbackEdges: number;
  };
}

// ---------------------------------------------------------------------------
// Movement profiles
// ---------------------------------------------------------------------------

export const MovementProfileSchema = z.object({
  name: z.string(),
  description: z.string().default(''),
  /** Ground speed, metres/second. */
  v_ground: z.number().positive(),
  /** Effective vertical climb rate, m/s. Applied to positive dz. */
  v_climb: z.number().positive(),
  /** Effective descent rate, m/s. Applied to negative dz. */
  v_glide: z.number().positive(),
  /** Swim speed, m/s. */
  v_swim: z.number().positive(),
  /** Flight speed, m/s. null when the profile cannot fly. */
  v_mount: z.number().positive().nullable().default(null),
  /** Multiplier applied to water segments. */
  water_penalty: z.number().positive().default(1),
  can_fly: z.boolean().default(false),
  /** Where the speed numbers came from. */
  speed_source: z.string().default('unmeasured'),
});
export type MovementProfile = z.infer<typeof MovementProfileSchema>;

export const ProfilesFileSchema = z.object({
  default_profile: z.string(),
  teleport_cost_seconds: z.number().nonnegative(),
  map_open_cost_seconds: z.number().nonnegative(),
  dungeon_enter_cost_seconds: z.record(z.string(), z.number().nonnegative()),
  profiles: z.array(MovementProfileSchema),
});
export type ProfilesFile = z.infer<typeof ProfilesFileSchema>;

// ---------------------------------------------------------------------------
// Solver results
// ---------------------------------------------------------------------------

export interface RouteLeg {
  from: Poi;
  to: Poi;
  mode: EdgeMode;
  seconds: number;
  cumulativeSeconds: number;
  estimated: boolean;
  note?: string;
}

export interface Route {
  /** Beacon this route starts from. */
  startBeacon: Poi | null;
  target: Poi;
  totalSeconds: number;
  legs: RouteLeg[];
  /** True if any leg is estimated. */
  anyEstimated: boolean;
  teleportHops: number;
}

export interface TourStop {
  poi: Poi;
  arrivalSeconds: number;
  legSeconds: number;
  teleportHops: number;
  estimated: boolean;
}

export interface TourResult {
  startBeacon: Poi | null;
  stops: TourStop[];
  totalSeconds: number;
  /** Targets the graph could not reach. */
  unreachable: Poi[];
  seedSeconds: number;
  improvedSeconds: number;
  twoOptIterations: number;
  /** Path to each stop, index-aligned with `stops`. Null where reconstruction failed. */
  routes: (Route | null)[];
}
