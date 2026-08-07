import type { Edge, Graph, Poi, Route, RouteLeg } from '../types.js';
import { MinHeap } from './heap.js';

// Multi-source Dijkstra with an implicit super-source: each source is seeded at
// its entry cost with itself as origin, and `origin` propagates on relaxation.
// One run yields, for every POI, its travel time and the source it came from.

export interface DijkstraSource {
  /** Node index. */
  node: number;
  /** Entry cost charged when starting from this node. */
  cost: number;
}

export interface DijkstraResult {
  dist: Float64Array;
  /** Predecessor node index, -1 at sources and unreachable nodes. */
  prev: Int32Array;
  /** Edge used to arrive at each node, for cost breakdowns. */
  prevEdge: (Edge | null)[];
  /** Source node each shortest path started from, -1 if unreachable. */
  origin: Int32Array;
  /** Nodes settled, for reporting. */
  settled: number;
}

export function multiSourceDijkstra(
  graph: Graph,
  sources: DijkstraSource[],
): DijkstraResult {
  const n = graph.nodes.length;
  const dist = new Float64Array(n).fill(Infinity);
  const prev = new Int32Array(n).fill(-1);
  const origin = new Int32Array(n).fill(-1);
  const prevEdge: (Edge | null)[] = new Array(n).fill(null);
  const done = new Uint8Array(n);
  const heap = new MinHeap<number>();

  for (const s of sources) {
    if (s.node < 0 || s.node >= n) continue;
    if (s.cost < dist[s.node]!) {
      dist[s.node] = s.cost;
      origin[s.node] = s.node;
      heap.push(s.cost, s.node);
    }
  }

  let settled = 0;
  for (;;) {
    const top = heap.pop();
    if (!top) break;
    const u = top.value;
    if (done[u]) continue; // stale entry
    done[u] = 1;
    settled++;

    for (const e of graph.adj[u]!) {
      const v = e.to;
      if (done[v]) continue;
      const nd = dist[u]! + e.weight;
      if (nd < dist[v]!) {
        dist[v] = nd;
        prev[v] = u;
        prevEdge[v] = e;
        origin[v] = origin[u]!;
        heap.push(nd, v);
      }
    }
  }

  return { dist, prev, prevEdge, origin, settled };
}

/** Seed a run from every unlocked beacon, charging `mapOpenCost` at each source. */
export function beaconSources(
  graph: Graph,
  mapOpenCost: number,
): DijkstraSource[] {
  const out: DijkstraSource[] = [];
  for (const id of graph.meta.unlockedBeacons) {
    const idx = graph.index.get(id);
    if (idx !== undefined) out.push({ node: idx, cost: mapOpenCost });
  }
  return out;
}

/** Single-source run, used for the tour distance matrix. */
export function singleSourceDijkstra(graph: Graph, from: number): DijkstraResult {
  return multiSourceDijkstra(graph, [{ node: from, cost: 0 }]);
}

/** Walk `prev` back from a target and reconstruct the ordered legs. */
export function reconstructRoute(
  graph: Graph,
  result: DijkstraResult,
  target: number,
): Route | null {
  if (!Number.isFinite(result.dist[target]!)) return null;

  const chain: number[] = [];
  for (let cur = target; cur !== -1; cur = result.prev[cur]!) {
    chain.push(cur);
    if (result.prev[cur] === -1) break;
  }
  chain.reverse();

  const legs: RouteLeg[] = [];
  let cumulative = result.dist[chain[0]!]!;
  let teleportHops = 0;

  for (let i = 1; i < chain.length; i++) {
    const to = chain[i]!;
    const edge = result.prevEdge[to];
    if (!edge) continue;
    cumulative += edge.weight;
    if (edge.mode === 'teleport') teleportHops++;
    legs.push({
      from: graph.nodes[chain[i - 1]!]!,
      to: graph.nodes[to]!,
      mode: edge.mode,
      seconds: edge.weight,
      cumulativeSeconds: cumulative,
      estimated: edge.estimated,
      note: edge.note,
    });
  }

  const originIdx = result.origin[target]!;
  return {
    startBeacon: originIdx >= 0 ? (graph.nodes[originIdx] as Poi) : null,
    target: graph.nodes[target]!,
    totalSeconds: result.dist[target]!,
    legs,
    anyEstimated: legs.some((l) => l.estimated),
    teleportHops,
  };
}

export interface NearestResult {
  poi: Poi;
  seconds: number;
  startBeacon: Poi | null;
  anyEstimated: boolean;
}

/** Rank candidate targets by time-to-reach from the multi-source frontier. */
export function rankNearest(
  graph: Graph,
  result: DijkstraResult,
  candidateIndices: number[],
  limit?: number,
): { reachable: NearestResult[]; unreachable: Poi[] } {
  const reachable: NearestResult[] = [];
  const unreachable: Poi[] = [];

  for (const idx of candidateIndices) {
    const d = result.dist[idx]!;
    if (!Number.isFinite(d)) {
      unreachable.push(graph.nodes[idx]!);
      continue;
    }
    const originIdx = result.origin[idx]!;
    // Uses the arriving edge only, without reconstructing the full route.
    const arriving = result.prevEdge[idx];
    reachable.push({
      poi: graph.nodes[idx]!,
      seconds: d,
      startBeacon: originIdx >= 0 ? graph.nodes[originIdx]! : null,
      anyEstimated: arriving?.estimated ?? false,
    });
  }

  reachable.sort((a, b) => a.seconds - b.seconds);
  return {
    reachable: limit === undefined ? reachable : reachable.slice(0, limit),
    unreachable,
  };
}
