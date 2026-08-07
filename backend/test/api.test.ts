import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/api/server.js';
import { POIS_PATH, PROJECT_ROOT } from '../src/core/paths.js';

const exec = promisify(execFile);
const shippedExists = fs.existsSync(POIS_PATH);

describe.runIf(shippedExists)('HTTP API', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildServer();
  });

  afterAll(async () => {
    await app?.close();
  });

  const json = (res: { payload: string }) => JSON.parse(res.payload) as Record<string, any>;

  it('serves health and meta', async () => {
    expect(json(await app.inject({ url: '/health' })).ok).toBe(true);

    const meta = json(await app.inject({ url: '/meta' }));
    expect(meta['kinds'].length).toBeGreaterThan(0);
    expect(meta['profiles'].length).toBeGreaterThan(0);
    expect(meta['sources'].length).toBeGreaterThan(0);
    // Declared gaps are part of the response contract.
    expect(meta['declared_gaps'].length).toBeGreaterThan(0);
  });

  it('puts the terrain tier and banner on every response', async () => {
    for (const url of ['/meta', '/pois?limit=1', '/beacons']) {
      const body = json(await app.inject({ url }));
      expect(body['terrain']).toBeDefined();
      expect(body['terrain'].tier).toMatch(/^[AB]$/);
      if (body['terrain'].tier === 'B') {
        expect(body['terrain'].banner).toMatch(/TERRAIN NOT MODELLED/);
      }
    }
  });

  it('filters POIs by kind and biome', async () => {
    const res = json(await app.inject({ url: '/pois?kind=alpha_boss&limit=5' }));
    expect(res['pois'].length).toBeLessThanOrEqual(5);
    for (const p of res['pois']) expect(p.kind).toBe('alpha_boss');
  });

  it('rejects an unknown kind with 400 and a usable message', async () => {
    const res = await app.inject({ url: '/pois?kind=banana' });
    expect(res.statusCode).toBe(400);
    expect(json(res)['error']).toMatch(/kind must be one of/);
  });

  it('404s an unknown poi_id', async () => {
    const res = await app.inject({ url: '/route/definitely_not_a_poi' });
    expect(res.statusCode).toBe(404);
  });

  it('defaults to no unlocked beacons', async () => {
    const res = json(await app.inject({ url: '/nearest?kind=effigy&limit=3' }));
    const codes = res['warnings'].map((w: { code: string }) => w.code);
    expect(codes).toContain('no_unlocked_beacons');
    expect(res['graph'].unlocked_beacon_count).toBe(0);
  });

  it('accepts beacons as CSV on GET and as an array on POST, identically', async () => {
    const beacons = json(await app.inject({ url: '/beacons' }))['beacons']
      .slice(0, 5)
      .map((b: { poi_id: string }) => b.poi_id);

    const viaGet = json(
      await app.inject({
        url: `/nearest?kind=alpha_boss&limit=3&mount=none&unlockedBeacons=${beacons.join(',')}`,
      }),
    );
    const viaPost = json(
      await app.inject({
        method: 'POST',
        url: '/nearest',
        payload: { kind: 'alpha_boss', limit: 3, mount: 'none', unlockedBeacons: beacons },
      }),
    );

    expect(viaGet['results'].map((r: any) => r.poi.poi_id)).toEqual(
      viaPost['results'].map((r: any) => r.poi.poi_id),
    );
    expect(viaGet['graph'].unlocked_beacon_count).toBe(5);
  });

  it('changes the answer when the beacon set shrinks', async () => {
    const beacons: string[] = json(await app.inject({ url: '/beacons' }))['beacons'].map(
      (b: { poi_id: string }) => b.poi_id,
    );
    const target = json(await app.inject({ url: '/pois?kind=alpha_boss&limit=1' }))['pois'][0]
      .poi_id as string;

    const many = json(
      await app.inject({
        method: 'POST',
        url: `/route/${target}`,
        payload: { unlockedBeacons: beacons, mount: 'none' },
      }),
    );
    const few = json(
      await app.inject({
        method: 'POST',
        url: `/route/${target}`,
        payload: { unlockedBeacons: beacons.slice(0, 3), mount: 'none' },
      }),
    );

    expect(many['route']).not.toBeNull();
    // Fewer beacons can only raise the time, or make the target unreachable.
    if (few['route'] === null) {
      expect(few['reachable']).toBe(false);
      expect(few['warnings'].map((w: { code: string }) => w.code)).toContain(
        'unreachable_components',
      );
    } else {
      expect(many['route'].total_seconds).toBeLessThanOrEqual(few['route'].total_seconds);
    }
  });

  it('explains unreachability by disconnected landmass rather than staying silent', async () => {
    const beacons: string[] = json(await app.inject({ url: '/beacons' }))['beacons']
      .slice(0, 3)
      .map((b: { poi_id: string }) => b.poi_id);
    const res = json(
      await app.inject({
        method: 'POST',
        url: '/nearest',
        payload: { kind: 'effigy', limit: 5, mount: 'none', unlockedBeacons: beacons },
      }),
    );
    const codes = res['warnings'].map((w: { code: string }) => w.code);
    expect(codes).toContain('unreachable_components');
    const msg = res['warnings'].find(
      (w: { code: string }) => w.code === 'unreachable_components',
    ).message;
    expect(msg).toMatch(/disconnected component/);
  });

  it('solves a tour and never drops targets silently', async () => {
    const beacons: string[] = json(await app.inject({ url: '/beacons' }))['beacons']
      .slice(0, 20)
      .map((b: { poi_id: string }) => b.poi_id);

    const total = json(await app.inject({ url: '/pois?kind=effigy' }))['total'] as number;
    const tour = json(
      await app.inject({
        method: 'POST',
        url: '/tour',
        payload: { kind: 'effigy', mount: 'nitewing', unlockedBeacons: beacons },
      }),
    );

    expect(tour['stop_count'] + tour['unreachable'].length).toBe(total);
    expect(tour['optimisation'].two_opt_seconds).toBeLessThanOrEqual(
      tour['optimisation'].nearest_neighbour_seconds + 1e-6,
    );
  });

  it('documents the one-per selection as a greedy simplification', async () => {
    const tour = json(
      await app.inject({
        url: '/tour?kind=alpha_boss&onePer=class_id&mount=jetragon',
      }),
    );
    expect(tour['selection'].method).toMatch(/generalized TSP/i);
    expect(tour['selection'].group_count).toBeGreaterThan(0);
  });

  it('serves the map overlay as SVG with residual headers', async () => {
    const beacons: string[] = json(await app.inject({ url: '/beacons' }))['beacons']
      .map((b: { poi_id: string }) => b.poi_id);
    const target = json(await app.inject({ url: '/pois?kind=alpha_boss&limit=1' }))['pois'][0]
      .poi_id as string;

    const res = await app.inject({
      url: `/map?target=${target}&unlockedBeacons=${beacons.join(',')}`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/image\/svg\+xml/);
    expect(res.headers['x-palroute-transform-residual']).toBeDefined();
    expect(res.headers['x-palroute-transform-holdout']).toBeDefined();
    expect(res.payload).toMatch(/^<svg/);
  });

  it('refuses to draw a map for an unreachable target instead of erroring out', async () => {
    const target = json(await app.inject({ url: '/pois?kind=alpha_boss&limit=1' }))['pois'][0]
      .poi_id as string;
    // With no beacons there is no route to draw.
    const res = await app.inject({ url: `/map?target=${target}` });
    expect(res.statusCode).toBe(422);
    expect(json(res)['error']).toMatch(/nothing to draw/i);
  });

  it('exposes the validation report', async () => {
    const res = json(await app.inject({ url: '/validate' }));
    expect(res['report'].ok).toBe(true);
    expect(res['report'].checks.length).toBeGreaterThan(5);
  });
});

describe.runIf(shippedExists)('CLI exit codes', () => {
  // tsx's JS entry point; the .bin shim is not executable by node on Windows.
  const tsx = path.join(PROJECT_ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
  const cli = path.join(PROJECT_ROOT, 'src', 'cli.ts');

  const run = (args: string[]) =>
    exec(process.execPath, [tsx, cli, ...args], {
      cwd: PROJECT_ROOT,
      windowsHide: true,
    });

  it('exits 0 on the shipped dataset and prints per-kind counts', async () => {
    const { stdout } = await run(['validate', '--no-color']);
    expect(stdout).toMatch(/POIs by kind/);
    expect(stdout).toMatch(/validation OK/);
  }, 60_000);

  it('exits non-zero on a deliberately corrupted fixture', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'palroute-'));
    const corruptPath = path.join(dir, 'corrupt.json');
    const ds = JSON.parse(fs.readFileSync(POIS_PATH, 'utf8'));
    // Corrupt the fixture: move a POI out of bounds and drop a whole kind.
    ds.pois[0].world_x = 99_000_000;
    ds.pois = ds.pois.filter((p: { kind: string }) => p.kind !== 'fast_travel');
    fs.writeFileSync(corruptPath, JSON.stringify(ds));

    await expect(run(['validate', '--dataset', corruptPath, '--no-color'])).rejects.toMatchObject({
      code: 1,
    });

    fs.rmSync(dir, { recursive: true, force: true });
  }, 60_000);
});
