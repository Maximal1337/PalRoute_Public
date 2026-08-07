import { describe, expect, it } from 'vitest';
import { buildGraph } from '../src/graph/build.js';
import { multiSourceDijkstra, reconstructRoute } from '../src/solve/dijkstra.js';
import {
  poi,
  teleportVsWalkFixture,
  testProfiles,
  walkWinsFixture,
} from './helpers.js';

/**
 * Cost checks on toy fixtures, routed from a fixed start rather than the
 * multi-source frontier, so teleport edges appear in the path.
 */

function routeFromStart(
  pois: ReturnType<typeof teleportVsWalkFixture>,
  profileName: string,
  unlocked: string[],
  startId = 'start',
  targetId = 'target',
) {
  const graph = buildGraph({
    pois,
    profiles: testProfiles,
    profileName,
    unlockedBeacons: unlocked,
    radiusMetres: 500,
  });
  const start = graph.index.get(startId)!;
  const result = multiSourceDijkstra(graph, [{ node: start, cost: 0 }]);
  const route = reconstructRoute(graph, result, graph.index.get(targetId)!);
  return { graph, route };
}

describe('teleport vs walking', () => {
  const beacons = ['beacon_near_start', 'beacon_near_target'];

  it('chooses the teleport when walking is 400 m and the hop is 10 m either side', () => {
    const { route } = routeFromStart(teleportVsWalkFixture(), 'none', beacons);
    expect(route).not.toBeNull();
    expect(route!.teleportHops).toBe(1);
    expect(route!.legs.some((l) => l.mode === 'teleport')).toBe(true);
    // 10 m + 20 s hop + 10 m at 5.5 m/s
    expect(route!.totalSeconds).toBeCloseTo(10 / 5.5 + 20 + 10 / 5.5, 3);
  });

  it('walks when the target is 100 m away and the nearest beacon is 2 km off', () => {
    const { route } = routeFromStart(walkWinsFixture(), 'none', [
      'beacon_far',
      'beacon_far2',
    ]);
    expect(route).not.toBeNull();
    expect(route!.teleportHops).toBe(0);
    expect(route!.legs.every((l) => l.mode !== 'teleport')).toBe(true);
    expect(route!.totalSeconds).toBeCloseTo(100 / 5.5, 3);
  });

  it('locking the teleport network out forces the long walk', () => {
    const { route } = routeFromStart(teleportVsWalkFixture(), 'none', []);
    expect(route!.teleportHops).toBe(0);
    // Straight 400 m walk instead of the 23.6 s hop.
    expect(route!.totalSeconds).toBeGreaterThan(60);
  });
});

describe('movement profile changes the chosen route', () => {
  const pois = teleportVsWalkFixture();
  const beacons = ['beacon_near_start', 'beacon_near_target'];

  it('on foot the teleport wins, in the air the direct line wins', () => {
    const onFoot = routeFromStart(pois, 'none', beacons);
    const flying = routeFromStart(pois, 'jetragon', beacons);

    expect(onFoot.route!.teleportHops).toBe(1);
    expect(flying.route!.teleportHops).toBe(0);

    // Flying gives a single direct hop; walking does not.
    expect(flying.route!.legs).toHaveLength(1);
    expect(flying.route!.legs[0]!.mode).toBe('fly');
    expect(flying.route!.totalSeconds).toBeCloseTo(400 / 28, 3);

    // The two profiles pick different routes, not just different times.
    const footModes = onFoot.route!.legs.map((l) => l.mode);
    const flyModes = flying.route!.legs.map((l) => l.mode);
    expect(footModes).not.toEqual(flyModes);
  });

  it('flying ignores the climb that dominates the on-foot cost', () => {
    // 300 m across, 1000 m up.
    const cliff = [
      poi('start', 'effigy', 0, 0, 0),
      poi('target', 'alpha_boss', 300, 0, 1000),
    ];
    const foot = routeFromStart(cliff, 'none', []);
    const air = routeFromStart(cliff, 'jetragon', []);

    // 300/5.5 + 1000/1.6 = 54.5 + 625
    expect(foot.route!.totalSeconds).toBeCloseTo(300 / 5.5 + 1000 / 1.6, 2);
    // hypot(300, 1000)/28
    expect(air.route!.totalSeconds).toBeCloseTo(Math.hypot(300, 1000) / 28, 2);
    expect(air.route!.totalSeconds).toBeLessThan(foot.route!.totalSeconds / 10);
  });
});

describe('unlocked beacon set changes the answer', () => {
  /** Restricting to one beacon changes the reported start beacon and raises total time. */
  const pois = [
    poi('target', 'alpha_boss', 0, 0),
    poi('beacon_close', 'fast_travel', 20, 0),
    poi('beacon_far', 'fast_travel', 400, 0),
  ];

  const frontier = (unlocked: string[]) => {
    const graph = buildGraph({
      pois,
      profiles: testProfiles,
      profileName: 'none',
      unlockedBeacons: unlocked,
      radiusMetres: 500,
    });
    const sources = unlocked
      .map((id) => graph.index.get(id))
      .filter((i): i is number => i !== undefined)
      .map((node) => ({ node, cost: testProfiles.map_open_cost_seconds }));
    const result = multiSourceDijkstra(graph, sources);
    return reconstructRoute(graph, result, graph.index.get('target')!);
  };

  it('reports a different start beacon and a longer time with fewer beacons', () => {
    const both = frontier(['beacon_close', 'beacon_far'])!;
    const onlyFar = frontier(['beacon_far'])!;

    expect(both.startBeacon?.poi_id).toBe('beacon_close');
    expect(onlyFar.startBeacon?.poi_id).toBe('beacon_far');
    expect(onlyFar.totalSeconds).toBeGreaterThan(both.totalSeconds);
  });

  it('defaults to no beacons rather than all of them', () => {
    const graph = buildGraph({
      pois,
      profiles: testProfiles,
      profileName: 'none',
      // unlockedBeacons omitted
      radiusMetres: 500,
    });
    expect(graph.meta.unlockedBeacons).toEqual([]);
    const teleportEdges = graph.adj.flat().filter((e) => e.mode === 'teleport');
    expect(teleportEdges).toHaveLength(0);
  });
});

describe('cost model units', () => {
  it('weights are seconds, so teleport and walking are directly comparable', () => {
    const graph = buildGraph({
      pois: teleportVsWalkFixture(),
      profiles: testProfiles,
      profileName: 'none',
      unlockedBeacons: ['beacon_near_start', 'beacon_near_target'],
      radiusMetres: 500,
      teleportCostSeconds: 20,
    });
    const teleport = graph.adj.flat().find((e) => e.mode === 'teleport')!;
    expect(teleport.weight).toBe(20);

    // A 10 m walk at 5.5 m/s is 1.82 s, in the same unit as the hop.
    const startIdx = graph.index.get('start')!;
    const walk = graph.adj[startIdx]!.find(
      (e) => graph.nodes[e.to]!.poi_id === 'beacon_near_start',
    )!;
    expect(walk.weight).toBeCloseTo(10 / 5.5, 6);
  });
});
