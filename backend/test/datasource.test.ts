import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { largestGroup, readCoords, scanJson } from '../src/datasource/scan.js';
import { validateDataset } from '../src/datasource/validate.js';
import { loadExpectations } from '../src/core/config.js';
import { DatasetSchema, type Dataset } from '../src/types.js';
import { POIS_PATH } from '../src/core/paths.js';
import { fitTransform, holdoutValidate } from '../src/core/mapTransform.js';

/** Data-layer acceptance checks. */

const shippedExists = fs.existsSync(POIS_PATH);
const loadShipped = (): Dataset =>
  DatasetSchema.parse(JSON.parse(fs.readFileSync(POIS_PATH, 'utf8')));

describe('field-signature scanner (no hardcoded table names)', () => {
  it('finds records in a keyed map of {x,y,z}', () => {
    const raw = {
      A1: { x: 1, y: 2, z: 3 },
      B2: { x: 4, y: 5, z: 6 },
      C3: { x: 7, y: 8, z: 9 },
      D4: { x: 10, y: 11, z: 12 },
    };
    const g = largestGroup(scanJson(raw))!;
    expect(g.records).toHaveLength(4);
    expect(g.coords.z).toBe('z');
    expect(readCoords(g.records[0]!, g.coords)).toEqual({ x: 1, y: 2, z: 3 });
  });

  it('finds records nested under an arbitrary table name', () => {
    // Table name unknown to the code.
    const raw = {
      DT_SomeTableRenamedByAPatch_v3: {
        Rows: {
          r1: { LocationX: 10, LocationY: 20, LocationZ: 30, Class: 'BP_Thing_C' },
          r2: { LocationX: 11, LocationY: 21, LocationZ: 31, Class: 'BP_Thing_C' },
          r3: { LocationX: 12, LocationY: 22, LocationZ: 32, Class: 'BP_Thing_C' },
          r4: { LocationX: 13, LocationY: 23, LocationZ: 33, Class: 'BP_Thing_C' },
        },
      },
    };
    const g = largestGroup(scanJson(raw))!;
    expect(g.records).toHaveLength(4);
    expect(readCoords(g.records[0]!, g.coords)).toEqual({ x: 10, y: 20, z: 30 });
    expect(g.fieldSignature).toContain('Class');
  });

  it('finds coordinates inside a nested container object', () => {
    const raw = [
      { Name: 'a', Location: { X: 1, Y: 2, Z: 3 } },
      { Name: 'b', Location: { X: 4, Y: 5, Z: 6 } },
      { Name: 'c', Location: { X: 7, Y: 8, Z: 9 } },
      { Name: 'd', Location: { X: 10, Y: 11, Z: 12 } },
    ];
    const g = largestGroup(scanJson(raw))!;
    expect(g.coords.container).toBe('location');
    expect(readCoords(g.records[1]!, g.coords)).toEqual({ x: 4, y: 5, z: 6 });
  });

  it('handles a source with x/y but no z', () => {
    const raw = [
      { type: 'dungeon', x: 1, y: 2 },
      { type: 'dungeon', x: 3, y: 4 },
      { type: 'dungeon', x: 5, y: 6 },
      { type: 'dungeon', x: 7, y: 8 },
    ];
    const g = largestGroup(scanJson(raw))!;
    expect(g.coords.z).toBeNull();
    expect(g.zCoverage).toBe(0);
    expect(readCoords(g.records[0]!, g.coords)).toEqual({ x: 1, y: 2, z: null });
  });

  it('fails loudly with a diagnostic rather than returning zero rows', () => {
    const raw = { config: { enabled: true }, items: ['a', 'b'] };
    const res = scanJson(raw);
    expect(res.groups).toHaveLength(0);
    expect(res.diagnostics).toHaveLength(1);
    expect(res.diagnostics[0]).toMatch(/No coordinate-bearing record group/);
    expect(res.diagnostics[0]).toMatch(/COORD_TRIPLES/);
  });
});

describe.runIf(shippedExists)('shipped dataset', () => {
  it('validates clean', async () => {
    const report = validateDataset(loadShipped(), await loadExpectations());
    expect(report.ok).toBe(true);
    const failures = report.checks.filter((c) => c.status === 'fail');
    expect(failures).toEqual([]);
  });

  it('reports per-kind counts', async () => {
    const report = validateDataset(loadShipped(), await loadExpectations());
    expect(Object.keys(report.countsByKind).length).toBeGreaterThan(3);
    expect(report.countsByKind['fast_travel']).toBeGreaterThan(50);
    expect(report.poiCount).toBeGreaterThan(100);
  });

  it('gives every POI a source, finite coordinates and a known kind', () => {
    const ds = loadShipped();
    for (const p of ds.pois) {
      expect(p.source).toBeTruthy();
      expect(Number.isFinite(p.world_x)).toBe(true);
      expect(Number.isFinite(p.world_y)).toBe(true);
    }
    // Kinds are checked by the schema parse above; check id uniqueness here.
    expect(new Set(ds.pois.map((p) => p.poi_id)).size).toBe(ds.pois.length);
  });

  it('never marks a map_unlock point as a teleport beacon', () => {
    const ds = loadShipped();
    const unlocks = ds.pois.filter((p) => p.kind === 'map_unlock');
    expect(unlocks.length).toBeGreaterThan(0);
    for (const u of unlocks) expect(u.class_id).toMatch(/UnlockMapPoint/i);
  });

  it('flags every POI that lacks a source Z', () => {
    const ds = loadShipped();
    for (const p of ds.pois) {
      if (p.world_z === null) expect(p.z_estimated).toBe(true);
    }
  });
});

describe.runIf(shippedExists)('corrupted fixtures fail validation', () => {
  const corrupt = (mutate: (d: Dataset) => void): Dataset => {
    const d = JSON.parse(JSON.stringify(loadShipped())) as Dataset;
    mutate(d);
    return d;
  };

  it('rejects a coordinate outside world extents', async () => {
    const exp = await loadExpectations();
    const bad = corrupt((d) => {
      d.pois[0]!.world_x = 99_000_000;
    });
    const report = validateDataset(bad, exp);
    expect(report.ok).toBe(false);
    expect(report.checks.find((c) => c.id === 'bounds')!.status).toBe('fail');
  });

  it('rejects a POI with a missing source', async () => {
    const exp = await loadExpectations();
    const bad = corrupt((d) => {
      d.pois[5]!.source = '';
    });
    const report = validateDataset(bad, exp);
    expect(report.ok).toBe(false);
  });

  it('rejects duplicate poi_ids', async () => {
    const exp = await loadExpectations();
    const bad = corrupt((d) => {
      d.pois[1]!.poi_id = d.pois[0]!.poi_id;
    });
    const report = validateDataset(bad, exp);
    expect(report.ok).toBe(false);
    expect(report.checks.find((c) => c.id === 'provenance-and-identity')!.status).toBe('fail');
  });

  it('rejects a wiped-out kind (silent import failure)', async () => {
    const exp = await loadExpectations();
    const bad = corrupt((d) => {
      d.pois = d.pois.filter((p) => p.kind !== 'fast_travel');
    });
    const report = validateDataset(bad, exp);
    expect(report.ok).toBe(false);
    expect(report.checks.find((c) => c.id === 'counts-by-kind')!.status).toBe('fail');
  });

  it('warns loudly on a game version mismatch', async () => {
    const exp = await loadExpectations();
    const bad = corrupt((d) => {
      d.game_version = 'some-other-patch';
    });
    const report = validateDataset(bad, exp);
    const check = report.checks.find((c) => c.id === 'game-version')!;
    expect(check.status).toBe('warn');
    expect(check.message).toMatch(/VERSION MISMATCH/);
  });
});

describe('map transform calibration', () => {
  it('is fitted from data, not hardcoded', () => {
    const points = [
      { label: 'p1', world: { x: -167230, y: 96430 }, map: { x: -134, y: -94 } },
      { label: 'p2', world: { x: -288669, y: 329207 }, map: { x: 373, y: -359 } },
    ];
    const fit = fitTransform(points, 'swap-similarity');
    // Reproduces its own inputs.
    expect(fit.maxFitResidual).toBeLessThan(1);
    // Lands near the community-published scale.
    expect(fit.similarity!.scale).toBeGreaterThan(400);
    expect(fit.similarity!.scale).toBeLessThan(520);
  });

  it('refuses to claim a hold-out it cannot perform', () => {
    const points = [
      { label: 'p1', world: { x: -167230, y: 96430 }, map: { x: -134, y: -94 } },
      { label: 'p2', world: { x: -288669, y: 329207 }, map: { x: 373, y: -359 } },
    ];
    const report = holdoutValidate(points, 'swap-similarity');
    expect(report.performed).toBe(false);
    expect(report.pass).toBe(false);
    expect(report.reason).toMatch(/at least 3 correspondences/);
  });

  it('performs a real hold-out once a third point exists', () => {
    // A third correspondence, so the hold-out path runs.
    const s = 459;
    const tx = 123888;
    const ty = -158000;
    const toMap = (x: number, y: number) => ({ x: (y + ty) / s, y: (x + tx) / s });
    const worlds = [
      { x: -167230, y: 96430 },
      { x: -288669, y: 329207 },
      { x: 42000, y: -110000 },
    ];
    const points = worlds.map((w, i) => ({
      label: `p${i}`,
      world: w,
      map: toMap(w.x, w.y),
      tolerance: 0.01,
    }));
    const report = holdoutValidate(points, 'swap-similarity');
    expect(report.performed).toBe(true);
    expect(report.pass).toBe(true);
    expect(report.maxResidual).toBeLessThan(0.01);
  });

  it('rejects degenerate correspondences instead of returning nonsense', () => {
    const dup = [
      { label: 'a', world: { x: 1, y: 1 }, map: { x: 1, y: 1 } },
      { label: 'b', world: { x: 1, y: 1 }, map: { x: 1, y: 1 } },
    ];
    expect(() => fitTransform(dup, 'swap-similarity')).toThrow(/singular|degenerate/i);
  });
});
