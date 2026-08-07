import type { Edge, Poi } from '../types.js';
import { dungeonCost } from '../core/config.js';
import type { ProfilesFile } from '../types.js';

// Layered world model: walk/fly/swim edges stay within one `level_id`, and
// crossing layers requires a portal edge. Each dungeon entrance gets a
// synthetic interior root, built here and never written to pois.json.

export const INTERIOR_LEVEL_PREFIX = 'dungeon:';

export function interiorLevelId(entrance: Poi): string {
  return `${INTERIOR_LEVEL_PREFIX}${entrance.poi_id}`;
}

/** Dungeon archetype, used to pick the per-archetype entry constant. */
export function archetypeOf(entrance: Poi): string {
  if (/tower/i.test(entrance.name) || /tower/i.test(entrance.class_id ?? '')) return 'tower';
  return 'dungeon';
}

export interface InteriorSynthesis {
  nodes: Poi[];
  /** entrance poi_id -> synthesized interior root poi_id */
  portalTargets: Map<string, string>;
}

/** One interior root per dungeon entrance, at the entrance's XY, marked z_estimated. */
export function synthesizeInteriors(pois: Poi[]): InteriorSynthesis {
  const nodes: Poi[] = [];
  const portalTargets = new Map<string, string>();

  for (const p of pois) {
    if (p.kind !== 'dungeon_entrance') continue;
    const id = `${p.poi_id}__interior`;
    nodes.push({
      poi_id: id,
      kind: 'dungeon_boss',
      name: `${p.name} (interior)`,
      class_id: p.class_id,
      level_id: interiorLevelId(p),
      biome: p.biome,
      world_x: p.world_x,
      world_y: p.world_y,
      world_z: p.world_z,
      // Position inherited from the entrance.
      z_estimated: true,
      requires: p.requires,
      boss_level: null,
      respawn_kind: 'timed',
      source: 'synthetic:dungeon-interior',
    });
    portalTargets.set(p.poi_id, id);
  }

  return { nodes, portalTargets };
}

/**
 * Portal edges: entrance -> interior root at a fixed per-archetype cost
 * covering the loading screen plus interior traversal. Always estimated.
 */
export function buildPortalEdges(
  nodes: Poi[],
  index: Map<string, number>,
  portalTargets: Map<string, string>,
  profiles: ProfilesFile,
): Edge[] {
  const edges: Edge[] = [];
  for (const [entranceId, interiorId] of portalTargets) {
    const from = index.get(entranceId);
    const to = index.get(interiorId);
    if (from === undefined || to === undefined) continue;
    const entrance = nodes[from]!;
    const archetype = archetypeOf(entrance);
    const cost = dungeonCost(profiles, archetype);
    const note = `portal: ${archetype} interior, constant ${cost}s (procedural interior not modelled)`;

    edges.push({ from, to, weight: cost, mode: 'portal', estimated: true, note });
    // Exit costs the loading screen only.
    edges.push({
      from: to,
      to: from,
      weight: Math.max(cost * 0.25, 10),
      mode: 'portal',
      estimated: true,
      note: `portal: exit ${archetype} (loading screen only)`,
    });
  }
  return edges;
}

/** Group node indices by level_id. */
export function partitionByLayer(nodes: Poi[]): Map<string, number[]> {
  const layers = new Map<string, number[]>();
  nodes.forEach((n, i) => {
    const arr = layers.get(n.level_id) ?? [];
    arr.push(i);
    layers.set(n.level_id, arr);
  });
  return layers;
}
