import type { Edge, Graph, Poi, ProfilesFile } from '../types.js';
import { TELEPORT_KINDS } from '../types.js';
import { getProfile } from '../core/config.js';
import { travelCost, UU_PER_METRE } from './cost.js';
import { buildPortalEdges, partitionByLayer, synthesizeInteriors } from './layers.js';
import { SpatialHash } from './spatial.js';
import { TierBTerrain, type TerrainProvider } from './terrain.js';

// A radius graph within each layer. Nodes with too few neighbours inside the
// radius reach their k nearest instead, and those long edges are flagged.

export const DEFAULT_RADIUS_METRES = 500;
export const MIN_DEGREE = 3;

export interface BuildGraphOptions {
  pois: Poi[];
  profiles: ProfilesFile;
  profileName?: string;
  terrain?: TerrainProvider;
  radiusMetres?: number;
  teleportCostSeconds?: number;
  /** Unlocked beacon poi_ids. Empty means no teleport edges. */
  unlockedBeacons?: string[];
  /** Synthesize dungeon interior layers. Default true. */
  dungeonInteriors?: boolean;
  minDegree?: number;
}

export function buildGraph(opts: BuildGraphOptions): Graph {
  const profile = getProfile(opts.profiles, opts.profileName);
  const terrain = opts.terrain ?? new TierBTerrain();
  const radiusMetres = opts.radiusMetres ?? DEFAULT_RADIUS_METRES;
  const radiusUU = radiusMetres * UU_PER_METRE;
  const teleportCost = opts.teleportCostSeconds ?? opts.profiles.teleport_cost_seconds;
  const minDegree = opts.minDegree ?? MIN_DEGREE;

  // --- nodes -------------------------------------------------------------
  let nodes: Poi[] = [...opts.pois];
  let portalTargets = new Map<string, string>();
  if (opts.dungeonInteriors !== false) {
    const synth = synthesizeInteriors(nodes);
    nodes = nodes.concat(synth.nodes);
    portalTargets = synth.portalTargets;
  }

  const index = new Map<string, number>();
  nodes.forEach((n, i) => index.set(n.poi_id, i));

  const adj: Edge[][] = nodes.map(() => []);
  let longFallbackEdges = 0;

  const addEdge = (e: Edge): void => {
    adj[e.from]!.push(e);
  };

  const addUndirected = (i: number, j: number, forceNote?: string): void => {
    const a = nodes[i]!;
    const b = nodes[j]!;
    if (terrain.isBlocked(a, b)) return;

    const modelled = terrain.pathSeconds(a, b, profile);
    const straight = travelCost(a, b, {
      profile,
      terrainTier: terrain.tier,
      crossesWater: (x, y) => terrain.crossesWater(x, y),
    });

    const seconds = modelled ?? straight.seconds;
    const notes = [straight.note, forceNote].filter(Boolean) as string[];
    const estimated = modelled === null ? straight.estimated : false;

    const base: Omit<Edge, 'from' | 'to'> = {
      weight: seconds,
      mode: straight.mode,
      estimated,
      note: notes.length ? notes.join('; ') : undefined,
    };
    addEdge({ ...base, from: i, to: j });
    addEdge({ ...base, from: j, to: i });
  };

  // --- within-layer edges ------------------------------------------------
  const layers = partitionByLayer(nodes);
  const linked = new Set<string>();
  const pairKey = (i: number, j: number) => (i < j ? `${i}:${j}` : `${j}:${i}`);

  for (const [, members] of layers) {
    if (members.length < 2) continue;

    // Per-layer index, so no query can return a node from another layer.
    const hash = new SpatialHash(Math.max(radiusUU, 1));
    const localIndex = new Map<number, number>();
    members.forEach((globalIdx, localIdx) => {
      const n = nodes[globalIdx]!;
      hash.insert(localIdx, n.world_x, n.world_y);
      localIndex.set(localIdx, globalIdx);
    });

    members.forEach((globalIdx, localIdx) => {
      const n = nodes[globalIdx]!;
      const near = hash.within(n.world_x, n.world_y, radiusUU, localIdx);

      for (const localJ of near) {
        const globalJ = localIndex.get(localJ)!;
        const key = pairKey(globalIdx, globalJ);
        if (linked.has(key)) continue;
        linked.add(key);
        addUndirected(globalIdx, globalJ);
      }

      // MIN_DEGREE guarantee.
      if (near.length < minDegree) {
        const need = minDegree - near.length;
        const extra = hash.kNearest(n.world_x, n.world_y, near.length + need, localIdx);
        for (const localJ of extra) {
          const globalJ = localIndex.get(localJ)!;
          const key = pairKey(globalIdx, globalJ);
          if (linked.has(key)) continue;
          linked.add(key);
          const m = nodes[globalJ]!;
          const distM = Math.hypot(m.world_x - n.world_x, m.world_y - n.world_y) / UU_PER_METRE;
          longFallbackEdges++;
          addUndirected(
            globalIdx,
            globalJ,
            `long fallback edge (${distM.toFixed(0)} m > ${radiusMetres} m radius) added to satisfy MIN_DEGREE=${minDegree}`,
          );
        }
      }
    });
  }

  // --- teleport clique ---------------------------------------------------
  // Unlocked beacons only.
  const unlocked = new Set(opts.unlockedBeacons ?? []);
  const beacons = nodes
    .map((n, i) => ({ n, i }))
    .filter(({ n }) => TELEPORT_KINDS.includes(n.kind) && unlocked.has(n.poi_id))
    .map(({ i }) => i);

  for (let a = 0; a < beacons.length; a++) {
    for (let b = a + 1; b < beacons.length; b++) {
      const i = beacons[a]!;
      const j = beacons[b]!;
      const e: Omit<Edge, 'from' | 'to'> = {
        weight: teleportCost,
        mode: 'teleport',
        estimated: false,
        note: 'fast travel',
      };
      addEdge({ ...e, from: i, to: j });
      addEdge({ ...e, from: j, to: i });
    }
  }

  // --- portal edges ------------------------------------------------------
  for (const e of buildPortalEdges(nodes, index, portalTargets, opts.profiles)) {
    addEdge(e);
  }

  const edgeCount = adj.reduce((n, list) => n + list.length, 0);
  const estimatedEdgeCount = adj.reduce(
    (n, list) => n + list.filter((e) => e.estimated).length,
    0,
  );

  return {
    nodes,
    adj,
    index,
    meta: {
      terrainTier: terrain.tier,
      profile: profile.name,
      teleportCost,
      radiusMetres,
      unlockedBeacons: [...unlocked],
      edgeCount,
      estimatedEdgeCount,
      longFallbackEdges,
    },
  };
}

/** Connected components. Separate landmasses form separate components. */
export function connectedComponents(g: Graph): number[][] {
  const seen = new Uint8Array(g.nodes.length);
  const out: number[][] = [];
  for (let i = 0; i < g.nodes.length; i++) {
    if (seen[i]) continue;
    const comp: number[] = [];
    const stack = [i];
    seen[i] = 1;
    while (stack.length > 0) {
      const u = stack.pop()!;
      comp.push(u);
      for (const e of g.adj[u]!) {
        if (!seen[e.to]) {
          seen[e.to] = 1;
          stack.push(e.to);
        }
      }
    }
    out.push(comp);
  }
  return out;
}

/** Node indices with no outgoing edges. */
export function isolatedNodes(g: Graph): number[] {
  const out: number[] = [];
  g.adj.forEach((list, i) => {
    if (list.length === 0) out.push(i);
  });
  return out;
}

/** Every beacon in the dataset, unlocked or not. */
export function allBeaconIds(pois: Poi[]): string[] {
  return pois.filter((p) => TELEPORT_KINDS.includes(p.kind)).map((p) => p.poi_id);
}
