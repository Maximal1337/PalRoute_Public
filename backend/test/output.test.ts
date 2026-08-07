import { describe, expect, it } from 'vitest';
import { buildGraph } from '../src/graph/build.js';
import { multiSourceDijkstra, reconstructRoute } from '../src/solve/dijkstra.js';
import { renderRoute, setColor } from '../src/render/text.js';
import { renderMap } from '../src/render/map.js';
import { routeToJson } from '../src/render/json.js';
import type { EngineWarning } from '../src/core/engine.js';
import type { Expectations } from '../src/core/config.js';
import { teleportVsWalkFixture, testProfiles } from './helpers.js';

/** Output acceptance checks. */

setColor(false);

function teleportRoute() {
  const pois = teleportVsWalkFixture();
  const graph = buildGraph({
    pois,
    profiles: testProfiles,
    profileName: 'none',
    unlockedBeacons: ['beacon_near_start', 'beacon_near_target'],
    radiusMetres: 500,
  });
  const res = multiSourceDijkstra(graph, [{ node: graph.index.get('start')!, cost: 0 }]);
  const route = reconstructRoute(graph, res, graph.index.get('target')!)!;
  return { graph, route };
}

const TIER_B_WARNING: EngineWarning = {
  code: 'terrain_tier_b',
  message:
    'TERRAIN NOT MODELLED (Tier B). Distances are straight lines with a Z penalty. ' +
    'Cliffs, water and island separation are ignored, so real travel times will be longer.',
};

describe('text output', () => {
  it('makes teleport hops visually distinct', () => {
    const { graph, route } = teleportRoute();
    const text = renderRoute(route, graph, []);

    expect(route.teleportHops).toBe(1);
    // The hop carries its own label.
    expect(text).toContain('FAST TRAVEL');
    expect(text).toContain('⇒');
    expect(text).toMatch(/Includes 1 fast-travel hop/);

    // Walking legs carry no teleport marker.
    const teleportLines = text.split('\n').filter((l) => l.includes('FAST TRAVEL'));
    expect(teleportLines).toHaveLength(1);
  });

  it('prints a prominent banner when terrain is not modelled', () => {
    const { graph, route } = teleportRoute();
    const text = renderRoute(route, graph, [TIER_B_WARNING]);
    expect(text).toMatch(/TERRAIN NOT MODELLED \(Tier B\)/);
    // The banner comes first in the output.
    expect(text.indexOf('TERRAIN NOT MODELLED')).toBeLessThan(text.indexOf('Route to'));
  });

  it('marks estimated legs', () => {
    const { graph, route } = teleportRoute();
    const text = renderRoute(route, graph, []);
    // Under Tier B walking legs are estimated; the teleport hop is not.
    expect(route.legs.some((l) => l.estimated)).toBe(true);
    expect(route.legs.find((l) => l.mode === 'teleport')!.estimated).toBe(false);
    expect(text).toContain('[est]');
  });

  it('reports the originating beacon', () => {
    const { graph, route } = teleportRoute();
    const text = renderRoute(route, graph, []);
    expect(text).toMatch(/Start from:/);
  });

  it('says so plainly when there is no route', () => {
    const { graph } = teleportRoute();
    const text = renderRoute(null, graph, []);
    expect(text).toMatch(/No route found/);
  });
});

describe('json output', () => {
  it('carries per-edge cost, mode and estimated flags', () => {
    const { route } = teleportRoute();
    const json = routeToJson(route)!;
    expect(json.total_seconds).toBeGreaterThan(0);
    expect(json.teleport_hops).toBe(1);
    expect(json.legs.length).toBeGreaterThan(0);
    for (const leg of json.legs) {
      expect(leg).toHaveProperty('seconds');
      expect(leg).toHaveProperty('cumulative_seconds');
      expect(leg).toHaveProperty('mode');
      expect(leg).toHaveProperty('estimated');
      expect(leg.from.world).toHaveProperty('x');
      expect(leg.to.world).toHaveProperty('y');
    }
    expect(json.legs.some((l) => l.mode === 'teleport')).toBe(true);
  });

  it('cumulative cost is monotonic and ends at the total', () => {
    const { route } = teleportRoute();
    const json = routeToJson(route)!;
    let prev = -Infinity;
    for (const leg of json.legs) {
      expect(leg.cumulative_seconds).toBeGreaterThanOrEqual(prev);
      prev = leg.cumulative_seconds;
    }
    expect(prev).toBeCloseTo(json.total_seconds, 6);
  });
});

describe('map overlay', () => {
  const expWithTwo = {
    calibration: [
      { label: 'a', world: { x: -167230, y: 96430 }, map: { x: -134, y: -94 }, tolerance: 2 },
      { label: 'b', world: { x: -288669, y: 329207 }, map: { x: 373, y: -359 }, tolerance: 2 },
    ],
  } as unknown as Expectations;

  it('reports the residual and refuses to imply an unperformed hold-out', () => {
    const { route } = teleportRoute();
    const out = renderMap({ route }, expWithTwo);

    expect(out.transform.max_fit_residual).toBeLessThan(2);
    expect(out.transform.holdout.performed).toBe(false);
    expect(out.transform.holdout.max_residual).toBeNull();
    // The caveat is rendered into the SVG, not only the payload.
    expect(out.svg).toMatch(/HOLD-OUT NOT PERFORMED/);
  });

  it('reports a real hold-out residual under the stated threshold when it can', () => {
    const s = 459;
    const tx = 123888;
    const ty = -158000;
    const toMap = (x: number, y: number) => ({ x: (y + ty) / s, y: (x + tx) / s });
    const worlds = [
      { x: -167230, y: 96430 },
      { x: -288669, y: 329207 },
      { x: 42000, y: -110000 },
    ];
    const exp = {
      calibration: worlds.map((w, i) => ({
        label: `p${i}`,
        world: w,
        map: toMap(w.x, w.y),
        tolerance: 0.5,
      })),
    } as unknown as Expectations;

    const { route } = teleportRoute();
    const out = renderMap({ route }, exp);
    expect(out.transform.holdout.performed).toBe(true);
    expect(out.transform.holdout.pass).toBe(true);
    expect(out.transform.holdout.max_residual!).toBeLessThan(0.5);
    expect(out.svg).toMatch(/leave-one-out max residual/);
  });

  it('draws teleport legs with a distinct stroke', () => {
    const { route } = teleportRoute();
    const out = renderMap({ route }, expWithTwo);
    // Teleport and walking legs use different colours.
    expect(out.svg).toContain('#c96bd8');
    expect(out.svg).toContain('stroke-dasharray');
    expect(out.svg).toMatch(/FAST TRAVEL|teleport/);
  });

  it('refuses to render without enough calibration points', () => {
    const { route } = teleportRoute();
    const tooFew = { calibration: [expWithTwo.calibration[0]!] } as unknown as Expectations;
    expect(() => renderMap({ route }, tooFew)).toThrow(/at least 2 calibration/);
  });
});
