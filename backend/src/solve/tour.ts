import type { Graph, Poi, Route, TourResult, TourStop } from '../types.js';
import {
  beaconSources,
  multiSourceDijkstra,
  reconstructRoute,
  singleSourceDijkstra,
  type DijkstraResult,
} from './dijkstra.js';

// Set-visiting: pairwise Dijkstra matrix, nearest-neighbour seed, then 2-opt.
// The matrix is asymmetric — d(i,j) != d(j,i) — because of portal edges.

export interface TourOptions {
  graph: Graph;
  /** Node indices to visit. */
  targets: number[];
  /** Charged when entering the world via a beacon. */
  mapOpenCost: number;
  /** Cap on 2-opt passes. */
  maxTwoOptPasses?: number;
  /** Include full leg-by-leg routes between stops. */
  withRoutes?: boolean;
}

export interface DistanceMatrix {
  /** matrix[i][j] = seconds from targets[i] to targets[j]. */
  matrix: number[][];
  /** Per-target single-source results, reused for path reconstruction. */
  runs: DijkstraResult[];
  reachableTargets: number[];
  unreachableTargets: number[];
}

/** One Dijkstra run per target. O(T * E log V). */
export function buildDistanceMatrix(graph: Graph, targets: number[]): DistanceMatrix {
  const runs = targets.map((t) => singleSourceDijkstra(graph, t));
  const matrix: number[][] = targets.map((_, i) =>
    targets.map((tj, j) => (i === j ? 0 : runs[i]!.dist[tj]!)),
  );

  // A target is unreachable if nothing else can reach it (or it reaches nothing).
  const reachableTargets: number[] = [];
  const unreachableTargets: number[] = [];
  targets.forEach((t, i) => {
    const reachesSomething = matrix[i]!.some((v, j) => j !== i && Number.isFinite(v));
    const reachedBySomething = targets.some((_, j) => j !== i && Number.isFinite(matrix[j]![i]!));
    if (targets.length === 1 || (reachesSomething && reachedBySomething)) reachableTargets.push(i);
    else unreachableTargets.push(i);
  });

  return { matrix, runs, reachableTargets, unreachableTargets };
}

/** Greedy nearest-neighbour seed from a fixed starting index. */
export function nearestNeighbourTour(
  matrix: number[][],
  members: number[],
  start: number,
): number[] {
  const unvisited = new Set(members);
  unvisited.delete(start);
  const order = [start];
  let cur = start;

  while (unvisited.size > 0) {
    let best = -1;
    let bestCost = Infinity;
    for (const cand of unvisited) {
      const c = matrix[cur]![cand]!;
      if (c < bestCost) {
        bestCost = c;
        best = cand;
      }
    }
    // Remaining targets are unreachable; appended in a stable order.
    if (best === -1) {
      for (const rest of unvisited) order.push(rest);
      break;
    }
    order.push(best);
    unvisited.delete(best);
    cur = best;
  }
  return order;
}

export function tourCost(matrix: number[][], order: number[]): number {
  let total = 0;
  for (let i = 1; i < order.length; i++) {
    const c = matrix[order[i - 1]!]![order[i]!]!;
    if (!Number.isFinite(c)) return Infinity;
    total += c;
  }
  return total;
}

/**
 * 2-opt on an open path. Each candidate is recosted in full, since an
 * asymmetric matrix rules out the two-boundary-edge delta. Strict improvement only.
 */
export function twoOpt(
  matrix: number[][],
  order: number[],
  maxPasses = 40,
): { order: number[]; cost: number; passes: number } {
  let best = [...order];
  let bestCost = tourCost(matrix, best);
  let passes = 0;

  if (!Number.isFinite(bestCost)) return { order: best, cost: bestCost, passes };

  let improved = true;
  while (improved && passes < maxPasses) {
    improved = false;
    passes++;
    // i starts at 1; the start node is fixed.
    for (let i = 1; i < best.length - 1; i++) {
      for (let k = i + 1; k < best.length; k++) {
        const candidate = best.slice(0, i).concat(best.slice(i, k + 1).reverse(), best.slice(k + 1));
        const cost = tourCost(matrix, candidate);
        if (cost < bestCost - 1e-9) {
          best = candidate;
          bestCost = cost;
          improved = true;
        }
      }
    }
  }

  return { order: best, cost: bestCost, passes };
}

/** Solve a tour over `targets`, entering the world from the cheapest unlocked beacon. */
export function solveTour(opts: TourOptions): TourResult {
  const { graph, targets, mapOpenCost } = opts;

  const entry = multiSourceDijkstra(graph, beaconSources(graph, mapOpenCost));
  const dm = buildDistanceMatrix(graph, targets);

  const unreachable: Poi[] = dm.unreachableTargets.map((i) => graph.nodes[targets[i]!]!);

  // Targets no unlocked beacon can reach are also unreachable.
  const reachable = dm.reachableTargets.filter((i) => {
    const ok = Number.isFinite(entry.dist[targets[i]!]!);
    if (!ok) unreachable.push(graph.nodes[targets[i]!]!);
    return ok;
  });

  if (reachable.length === 0) {
    return {
      startBeacon: null,
      stops: [],
      totalSeconds: 0,
      unreachable,
      seedSeconds: 0,
      improvedSeconds: 0,
      twoOptIterations: 0,
      routes: [],
    };
  }

  // Start at whichever reachable target is cheapest to reach from the beacon network.
  let startIdx = reachable[0]!;
  for (const i of reachable) {
    if (entry.dist[targets[i]!]! < entry.dist[targets[startIdx]!]!) startIdx = i;
  }

  const seedOrder = nearestNeighbourTour(dm.matrix, reachable, startIdx);
  const seedSeconds = tourCost(dm.matrix, seedOrder);
  const opt = twoOpt(dm.matrix, seedOrder, opts.maxTwoOptPasses ?? 40);

  const approachSeconds = entry.dist[targets[opt.order[0]!]!]!;
  const startBeaconIdx = entry.origin[targets[opt.order[0]!]!]!;

  const stops: TourStop[] = [];
  const routes: (Route | null)[] = [];
  let cumulative = approachSeconds;

  opt.order.forEach((tIdx, position) => {
    const nodeIdx = targets[tIdx]!;
    let legSeconds: number;
    let hops = 0;
    let estimated = false;

    let legRoute: Route | null;
    if (position === 0) {
      legSeconds = approachSeconds;
      legRoute = reconstructRoute(graph, entry, nodeIdx);
    } else {
      const fromT = opt.order[position - 1]!;
      legSeconds = dm.matrix[fromT]![tIdx]!;
      cumulative += legSeconds;
      legRoute = reconstructRoute(graph, dm.runs[fromT]!, nodeIdx);
    }
    if (legRoute) {
      hops = legRoute.teleportHops;
      estimated = legRoute.anyEstimated;
    }
    // Pushed unconditionally, so routes[i] stays aligned with stops[i].
    if (opts.withRoutes) routes.push(legRoute);

    stops.push({
      poi: graph.nodes[nodeIdx]!,
      arrivalSeconds: cumulative,
      legSeconds,
      teleportHops: hops,
      estimated,
    });
  });

  return {
    startBeacon: startBeaconIdx >= 0 ? graph.nodes[startBeaconIdx]! : null,
    stops,
    totalSeconds: cumulative,
    unreachable,
    seedSeconds: seedSeconds + approachSeconds,
    improvedSeconds: opt.cost + approachSeconds,
    twoOptIterations: opt.passes,
    routes,
  };
}

/**
 * "One of each type": group by `class_id` or `kind`, keep whichever member is
 * cheapest to reach. Greedy, not an optimal GTSP solution.
 */
export function selectOnePerGroup(
  graph: Graph,
  candidateIndices: number[],
  groupBy: 'class_id' | 'kind',
  mapOpenCost: number,
): { chosen: number[]; groups: Map<string, number[]>; method: string } {
  const entry = multiSourceDijkstra(graph, beaconSources(graph, mapOpenCost));
  const groups = new Map<string, number[]>();

  for (const idx of candidateIndices) {
    const node = graph.nodes[idx]!;
    const key = (groupBy === 'class_id' ? node.class_id : node.kind) ?? `(${node.kind})`;
    const arr = groups.get(key) ?? [];
    arr.push(idx);
    groups.set(key, arr);
  }

  const chosen: number[] = [];
  for (const [, members] of groups) {
    let best = -1;
    let bestCost = Infinity;
    for (const m of members) {
      const d = entry.dist[m]!;
      if (d < bestCost) {
        bestCost = d;
        best = m;
      }
    }
    // Whole group unreachable; keep the first as its representative.
    chosen.push(best === -1 ? members[0]! : best);
  }

  return {
    chosen,
    groups,
    method:
      'greedy: representative nearest to the unlocked beacon network, chosen ' +
      'independently of tour order. This is a simplification of the ' +
      'generalized TSP, not an optimal GTSP solution.',
  };
}
