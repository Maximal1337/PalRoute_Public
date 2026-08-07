import { describe, expect, it } from 'vitest';
import { buildGraph, isolatedNodes } from '../src/graph/build.js';
import { INTERIOR_LEVEL_PREFIX } from '../src/graph/layers.js';
import { multiSourceDijkstra } from '../src/solve/dijkstra.js';
import {
  disconnectedFixture,
  dungeonFixture,
  poi,
  testProfiles,
} from './helpers.js';

/** Graph acceptance checks. */

describe('layer invariants', () => {
  it('no walk edge connects two different level_ids', () => {
    const graph = buildGraph({
      pois: disconnectedFixture(),
      profiles: testProfiles,
      profileName: 'none',
      radiusMetres: 500,
    });

    for (const list of graph.adj) {
      for (const e of list) {
        if (e.mode === 'portal' || e.mode === 'teleport') continue;
        expect(graph.nodes[e.from]!.level_id).toBe(graph.nodes[e.to]!.level_id);
      }
    }
  });

  it('keeps co-located nodes on different layers unreachable from each other', () => {
    // a1 and b1 share coordinates; only the layer separates them.
    const graph = buildGraph({
      pois: disconnectedFixture(),
      profiles: testProfiles,
      profileName: 'none',
      radiusMetres: 500,
    });
    const res = multiSourceDijkstra(graph, [
      { node: graph.index.get('a1')!, cost: 0 },
    ]);
    expect(Number.isFinite(res.dist[graph.index.get('a2')!]!)).toBe(true);
    expect(Number.isFinite(res.dist[graph.index.get('b1')!]!)).toBe(false);
  });

  it('every dungeon interior is reachable only through its entrance', () => {
    const graph = buildGraph({
      pois: dungeonFixture(),
      profiles: testProfiles,
      profileName: 'none',
      radiusMetres: 500,
    });

    const interiors = graph.nodes
      .map((n, i) => ({ n, i }))
      .filter(({ n }) => n.level_id.startsWith(INTERIOR_LEVEL_PREFIX));
    expect(interiors.length).toBeGreaterThan(0);

    for (const { n, i } of interiors) {
      // Every edge pointing into this interior node.
      const incoming = graph.adj
        .flat()
        .filter((e) => e.to === i);
      expect(incoming.length).toBeGreaterThan(0);
      for (const e of incoming) {
        expect(e.mode).toBe('portal');
        // Entry is only via the matching entrance.
        expect(n.poi_id).toBe(`${graph.nodes[e.from]!.poi_id}__interior`);
      }
    }
  });

  it('removing the entrance makes its interior unreachable', () => {
    const graph = buildGraph({
      pois: dungeonFixture(),
      profiles: testProfiles,
      profileName: 'none',
      radiusMetres: 500,
    });
    const interiorIdx = graph.index.get('entrance_a__interior')!;
    const entranceIdx = graph.index.get('entrance_a')!;

    // With the portal severed, nothing reaches the interior.
    graph.adj[entranceIdx] = graph.adj[entranceIdx]!.filter((e) => e.to !== interiorIdx);
    const res = multiSourceDijkstra(graph, [{ node: graph.index.get('beacon')!, cost: 0 }]);
    expect(Number.isFinite(res.dist[interiorIdx]!)).toBe(false);
  });

  it('portal edges are always flagged estimated', () => {
    const graph = buildGraph({
      pois: dungeonFixture(),
      profiles: testProfiles,
      profileName: 'none',
      radiusMetres: 500,
    });
    const portals = graph.adj.flat().filter((e) => e.mode === 'portal');
    expect(portals.length).toBeGreaterThan(0);
    expect(portals.every((e) => e.estimated)).toBe(true);
  });
});

describe('connectivity guarantees', () => {
  it('produces no isolated nodes even when POIs are far apart', () => {
    // Four nodes 5 km apart with a 500 m radius; only MIN_DEGREE connects them.
    const sparse = [
      poi('n1', 'effigy', 0, 0),
      poi('n2', 'effigy', 5000, 0),
      poi('n3', 'effigy', 10000, 0),
      poi('n4', 'effigy', 15000, 0),
    ];
    const graph = buildGraph({
      pois: sparse,
      profiles: testProfiles,
      profileName: 'none',
      radiusMetres: 500,
      minDegree: 3,
    });
    expect(isolatedNodes(graph)).toEqual([]);
  });

  it('flags long fallback edges rather than passing them off as normal', () => {
    const sparse = [
      poi('n1', 'effigy', 0, 0),
      poi('n2', 'effigy', 5000, 0),
      poi('n3', 'effigy', 10000, 0),
    ];
    const graph = buildGraph({
      pois: sparse,
      profiles: testProfiles,
      profileName: 'none',
      radiusMetres: 500,
      minDegree: 2,
    });

    expect(graph.meta.longFallbackEdges).toBeGreaterThan(0);
    const flagged = graph.adj
      .flat()
      .filter((e) => e.note?.includes('long fallback edge'));
    expect(flagged.length).toBeGreaterThan(0);
    for (const e of flagged) expect(e.estimated).toBe(true);
  });

  it('keeps a single node graph valid', () => {
    const graph = buildGraph({
      pois: [poi('solo', 'effigy', 0, 0)],
      profiles: testProfiles,
      profileName: 'none',
    });
    expect(graph.nodes).toHaveLength(1);
    expect(graph.meta.edgeCount).toBe(0);
  });
});

describe('teleport clique', () => {
  it('only connects beacons the player has unlocked', () => {
    const pois = [
      poi('b1', 'fast_travel', 0, 0),
      poi('b2', 'fast_travel', 1000, 0),
      poi('b3', 'fast_travel', 2000, 0),
    ];
    const graph = buildGraph({
      pois,
      profiles: testProfiles,
      profileName: 'none',
      unlockedBeacons: ['b1', 'b2'],
      radiusMetres: 100,
    });

    const teleports = graph.adj.flat().filter((e) => e.mode === 'teleport');
    // b1<->b2 only, as two directed edges.
    expect(teleports).toHaveLength(2);
    const touched = new Set(teleports.flatMap((e) => [graph.nodes[e.from]!.poi_id, graph.nodes[e.to]!.poi_id]));
    expect(touched).toEqual(new Set(['b1', 'b2']));
  });

  it('never treats a map_unlock point as a teleport endpoint', () => {
    // UnlockMapPoint entries are excluded from the teleport clique.
    const pois = [
      poi('b1', 'fast_travel', 0, 0),
      poi('u1', 'map_unlock', 1000, 0),
    ];
    const graph = buildGraph({
      pois,
      profiles: testProfiles,
      profileName: 'none',
      unlockedBeacons: ['b1', 'u1'],
      radiusMetres: 100,
    });
    expect(graph.adj.flat().filter((e) => e.mode === 'teleport')).toHaveLength(0);
  });
});
