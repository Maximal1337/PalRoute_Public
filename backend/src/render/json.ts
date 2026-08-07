import type { EngineWarning } from '../core/engine.js';
import type { Graph, Poi, Route, TourResult } from '../types.js';
import type { NearestResult } from '../solve/dijkstra.js';

// JSON output shapes, shared by the CLI's `--format json` and the HTTP API.

export interface JsonPoi {
  poi_id: string;
  kind: string;
  name: string;
  class_id: string | null;
  level_id: string;
  biome: string | null;
  world: { x: number; y: number; z: number | null };
  z_estimated: boolean;
  boss_level: number | null;
  respawn_kind: string;
  requires: string[];
  source: string;
}

export function poiToJson(p: Poi): JsonPoi {
  return {
    poi_id: p.poi_id,
    kind: p.kind,
    name: p.name,
    class_id: p.class_id,
    level_id: p.level_id,
    biome: p.biome,
    world: { x: p.world_x, y: p.world_y, z: p.world_z },
    z_estimated: p.z_estimated,
    boss_level: p.boss_level,
    respawn_kind: p.respawn_kind,
    requires: p.requires,
    source: p.source,
  };
}

export function graphMetaToJson(g: Graph) {
  return {
    node_count: g.nodes.length,
    edge_count: g.meta.edgeCount,
    estimated_edge_count: g.meta.estimatedEdgeCount,
    long_fallback_edges: g.meta.longFallbackEdges,
    terrain_tier: g.meta.terrainTier,
    profile: g.meta.profile,
    teleport_cost_seconds: g.meta.teleportCost,
    radius_metres: g.meta.radiusMetres,
    unlocked_beacon_count: g.meta.unlockedBeacons.length,
  };
}

export function routeToJson(route: Route | null) {
  if (!route) return null;
  return {
    target: poiToJson(route.target),
    start_beacon: route.startBeacon ? poiToJson(route.startBeacon) : null,
    total_seconds: route.totalSeconds,
    teleport_hops: route.teleportHops,
    any_estimated: route.anyEstimated,
    legs: route.legs.map((l) => ({
      from: { poi_id: l.from.poi_id, name: l.from.name, world: { x: l.from.world_x, y: l.from.world_y, z: l.from.world_z } },
      to: { poi_id: l.to.poi_id, name: l.to.name, world: { x: l.to.world_x, y: l.to.world_y, z: l.to.world_z } },
      mode: l.mode,
      seconds: l.seconds,
      cumulative_seconds: l.cumulativeSeconds,
      estimated: l.estimated,
      note: l.note ?? null,
    })),
  };
}

export function warningsToJson(warnings: EngineWarning[]) {
  return warnings.map((w) => ({ code: w.code, message: w.message }));
}

export function nearestToJson(
  reachable: NearestResult[],
  unreachable: Poi[],
  graph: Graph,
  warnings: EngineWarning[],
) {
  return {
    results: reachable.map((r) => ({
      poi: poiToJson(r.poi),
      seconds: r.seconds,
      start_beacon: r.startBeacon ? poiToJson(r.startBeacon) : null,
      estimated: r.anyEstimated,
    })),
    unreachable: unreachable.map(poiToJson),
    graph: graphMetaToJson(graph),
    warnings: warningsToJson(warnings),
  };
}

export function tourToJson(
  result: TourResult,
  graph: Graph,
  warnings: EngineWarning[],
  extra: { selectionMethod?: string; groupCount?: number } = {},
) {
  return {
    start_beacon: result.startBeacon ? poiToJson(result.startBeacon) : null,
    total_seconds: result.totalSeconds,
    stop_count: result.stops.length,
    teleport_hops: result.stops.reduce((n, s) => n + s.teleportHops, 0),
    optimisation: {
      nearest_neighbour_seconds: result.seedSeconds,
      two_opt_seconds: result.improvedSeconds,
      passes: result.twoOptIterations,
      improved: result.improvedSeconds < result.seedSeconds,
    },
    selection: extra.selectionMethod
      ? { method: extra.selectionMethod, group_count: extra.groupCount ?? null }
      : null,
    stops: result.stops.map((s, i) => ({
      order: i + 1,
      poi: poiToJson(s.poi),
      leg_seconds: s.legSeconds,
      arrival_seconds: s.arrivalSeconds,
      teleport_hops: s.teleportHops,
      estimated: s.estimated,
    })),
    unreachable: result.unreachable.map(poiToJson),
    routes: result.routes.map(routeToJson),
    graph: graphMetaToJson(graph),
    warnings: warningsToJson(warnings),
  };
}
