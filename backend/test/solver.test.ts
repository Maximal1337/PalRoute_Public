import { describe, expect, it } from 'vitest';
import { buildGraph } from '../src/graph/build.js';
import { multiSourceDijkstra } from '../src/solve/dijkstra.js';
import {
  buildDistanceMatrix,
  nearestNeighbourTour,
  solveTour,
  tourCost,
  twoOpt,
} from '../src/solve/tour.js';
import { disconnectedFixture, poi, testProfiles } from './helpers.js';

/** Solver acceptance checks. */

function ringFixture(n: number, radiusMetres = 800) {
  return Array.from({ length: n }, (_, i) => {
    const a = (i / n) * Math.PI * 2;
    return poi(`p${i}`, 'effigy', Math.cos(a) * radiusMetres, Math.sin(a) * radiusMetres);
  });
}

describe('2-opt', () => {
  it('never returns a tour worse than the nearest-neighbour seed', () => {
    // Randomised layouts.
    for (let trial = 0; trial < 25; trial++) {
      const pois = Array.from({ length: 12 }, (_, i) =>
        poi(`p${i}`, 'effigy', Math.random() * 3000, Math.random() * 3000),
      );
      const graph = buildGraph({
        pois,
        profiles: testProfiles,
        profileName: 'none',
        radiusMetres: 5000,
      });
      const targets = pois.map((p) => graph.index.get(p.poi_id)!);
      const dm = buildDistanceMatrix(graph, targets);
      const members = dm.reachableTargets;
      const seed = nearestNeighbourTour(dm.matrix, members, members[0]!);
      const seedCost = tourCost(dm.matrix, seed);
      const opt = twoOpt(dm.matrix, seed);

      expect(opt.cost).toBeLessThanOrEqual(seedCost + 1e-9);
      // Still a permutation of the same stops.
      expect([...opt.order].sort()).toEqual([...seed].sort());
    }
  });

  it('actually improves a deliberately bad seed', () => {
    const pois = ringFixture(10);
    const graph = buildGraph({
      pois,
      profiles: testProfiles,
      profileName: 'none',
      radiusMetres: 5000,
    });
    const targets = pois.map((p) => graph.index.get(p.poi_id)!);
    const dm = buildDistanceMatrix(graph, targets);
    // Interleaved order zig-zags across the ring.
    const bad = [0, 5, 1, 6, 2, 7, 3, 8, 4, 9];
    const badCost = tourCost(dm.matrix, bad);
    const opt = twoOpt(dm.matrix, bad);
    expect(opt.cost).toBeLessThan(badCost);
  });

  it('keeps the starting stop fixed', () => {
    const pois = ringFixture(8);
    const graph = buildGraph({
      pois,
      profiles: testProfiles,
      profileName: 'none',
      radiusMetres: 5000,
    });
    const targets = pois.map((p) => graph.index.get(p.poi_id)!);
    const dm = buildDistanceMatrix(graph, targets);
    const seed = nearestNeighbourTour(dm.matrix, dm.reachableTargets, 3);
    const opt = twoOpt(dm.matrix, seed);
    expect(opt.order[0]).toBe(3);
  });
});

describe('unreachable targets', () => {
  it('reports them explicitly instead of silently dropping them', () => {
    const pois = disconnectedFixture();
    const graph = buildGraph({
      pois,
      profiles: testProfiles,
      profileName: 'none',
      radiusMetres: 500,
      unlockedBeacons: [],
    });

    // Enter from cluster A only.
    const aStart = graph.index.get('a1')!;
    const targets = pois.map((p) => graph.index.get(p.poi_id)!);
    const result = solveTour({
      graph: {
        ...graph,
        // a1 is the only cheap entry, so the tour starts in cluster A.
        meta: { ...graph.meta, unlockedBeacons: [] },
      },
      targets,
      mapOpenCost: 0,
    });

    // Cluster B sits on another layer and is unreachable.
    const reported = new Set(result.unreachable.map((p) => p.poi_id));
    expect(reported.size).toBeGreaterThan(0);

    // Every target is either visited or reported unreachable.
    const visited = new Set(result.stops.map((s) => s.poi.poi_id));
    for (const p of pois) {
      expect(visited.has(p.poi_id) || reported.has(p.poi_id)).toBe(true);
    }
    expect(visited.size + reported.size).toBe(pois.length);
    void aStart;
  });

  it('rankNearest separates reachable from unreachable', () => {
    const graph = buildGraph({
      pois: disconnectedFixture(),
      profiles: testProfiles,
      profileName: 'none',
      radiusMetres: 500,
    });
    const res = multiSourceDijkstra(graph, [{ node: graph.index.get('a1')!, cost: 0 }]);
    expect(Number.isFinite(res.dist[graph.index.get('a3')!]!)).toBe(true);
    expect(Number.isFinite(res.dist[graph.index.get('b3')!]!)).toBe(false);
  });
});

describe('multi-source semantics', () => {
  it('one run yields both the time and the originating beacon for every POI', () => {
    const pois = [
      poi('bA', 'fast_travel', 0, 0),
      poi('bB', 'fast_travel', 1000, 0),
      poi('nearA', 'effigy', 50, 0),
      poi('nearB', 'effigy', 950, 0),
    ];
    const graph = buildGraph({
      pois,
      profiles: testProfiles,
      profileName: 'none',
      unlockedBeacons: ['bA', 'bB'],
      radiusMetres: 2000,
    });
    const res = multiSourceDijkstra(graph, [
      { node: graph.index.get('bA')!, cost: 3 },
      { node: graph.index.get('bB')!, cost: 3 },
    ]);

    // Each POI is attributed to its cheapest beacon.
    expect(graph.nodes[res.origin[graph.index.get('nearA')!]!]!.poi_id).toBe('bA');
    expect(graph.nodes[res.origin[graph.index.get('nearB')!]!]!.poi_id).toBe('bB');
    expect(res.dist[graph.index.get('nearA')!]!).toBeCloseTo(3 + 50 / 5.5, 6);
  });

  it('matches N separate single-source runs, but in one pass', () => {
    const pois = [
      poi('bA', 'fast_travel', 0, 0),
      poi('bB', 'fast_travel', 600, 0),
      poi('t1', 'effigy', 120, 0),
      poi('t2', 'effigy', 480, 0),
      poi('t3', 'effigy', 300, 200),
    ];
    const graph = buildGraph({
      pois,
      profiles: testProfiles,
      profileName: 'none',
      unlockedBeacons: ['bA', 'bB'],
      radiusMetres: 2000,
    });

    const multi = multiSourceDijkstra(graph, [
      { node: graph.index.get('bA')!, cost: 0 },
      { node: graph.index.get('bB')!, cost: 0 },
    ]);
    const fromA = multiSourceDijkstra(graph, [{ node: graph.index.get('bA')!, cost: 0 }]);
    const fromB = multiSourceDijkstra(graph, [{ node: graph.index.get('bB')!, cost: 0 }]);

    for (const id of ['t1', 't2', 't3']) {
      const i = graph.index.get(id)!;
      expect(multi.dist[i]!).toBeCloseTo(Math.min(fromA.dist[i]!, fromB.dist[i]!), 9);
    }
  });
});

describe('performance', () => {
  it('runs a multi-source pass over a full-size graph in well under 5 s', () => {
    // Roughly the scale of the shipped dataset.
    const pois = Array.from({ length: 700 }, (_, i) =>
      poi(
        `p${i}`,
        i % 10 === 0 ? 'fast_travel' : 'effigy',
        Math.random() * 12000,
        Math.random() * 10000,
        Math.random() * 500,
      ),
    );
    const unlocked = pois.filter((p) => p.kind === 'fast_travel').map((p) => p.poi_id);

    const t0 = performance.now();
    const graph = buildGraph({
      pois,
      profiles: testProfiles,
      profileName: 'none',
      unlockedBeacons: unlocked,
      radiusMetres: 500,
    });
    const res = multiSourceDijkstra(
      graph,
      unlocked.map((id) => ({ node: graph.index.get(id)!, cost: 3 })),
    );
    const elapsed = performance.now() - t0;

    expect(res.settled).toBeGreaterThan(0);
    expect(elapsed).toBeLessThan(5000);
  });
});
