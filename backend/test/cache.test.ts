import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pruneGraphCache, cacheKey } from '../src/core/cache.js';

/** Graph-cache eviction. */

let dir: string;

async function writeEntry(name: string, bytes: number, usedMsAgo: number): Promise<string> {
  const full = path.join(dir, `graph-${name}.json`);
  await fs.writeFile(full, 'x'.repeat(bytes), 'utf8');
  const when = new Date(Date.now() - usedMsAgo);
  await fs.utimes(full, when, when);
  return full;
}

async function names(): Promise<string[]> {
  return (await fs.readdir(dir)).sort();
}

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'palroute-cache-'));
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe('pruneGraphCache', () => {
  it('keeps everything when inside both limits', async () => {
    await writeEntry('a', 100, 3000);
    await writeEntry('b', 100, 2000);
    const removed = await pruneGraphCache(10_000, 10, dir);
    expect(removed).toBe(0);
    expect(await names()).toHaveLength(2);
  });

  it('evicts by least-recently-used, not by creation order', async () => {
    // `old` is written first but touched last, so it must survive.
    await writeEntry('old', 100, 1);
    await writeEntry('mid', 100, 5000);
    await writeEntry('new', 100, 9000);

    const removed = await pruneGraphCache(10_000, 1, dir);
    expect(removed).toBe(2);
    expect(await names()).toEqual(['graph-old.json']);
  });

  it('enforces the byte ceiling', async () => {
    await writeEntry('big1', 600, 1000);
    await writeEntry('big2', 600, 2000);
    await writeEntry('big3', 600, 3000);

    await pruneGraphCache(1500, 100, dir);
    const left = await names();
    expect(left).toEqual(['graph-big1.json', 'graph-big2.json']);
  });

  it('leaves unrelated files alone', async () => {
    await writeEntry('a', 100, 1000);
    await fs.writeFile(path.join(dir, 'notes.txt'), 'keep me', 'utf8');

    await pruneGraphCache(0, 0, dir);
    expect(await names()).toEqual(['notes.txt']);
  });

  it('returns 0 rather than throwing on a missing directory', async () => {
    const gone = path.join(dir, 'does-not-exist');
    expect(await pruneGraphCache(10, 10, gone)).toBe(0);
  });
});

describe('cacheKey', () => {
  it('is insensitive to beacon order', async () => {
    const base = {
      datasetFingerprint: 'f',
      profile: 'none',
      radiusMetres: 500,
      teleportCost: 20,
      terrainTier: 'B',
      dungeonInteriors: true,
      minDegree: 3,
    };
    const a = cacheKey({ ...base, unlockedBeacons: ['x', 'y', 'z'] });
    const b = cacheKey({ ...base, unlockedBeacons: ['z', 'x', 'y'] });
    expect(a).toBe(b);
  });

  it('changes when the beacon set changes', async () => {
    const base = {
      datasetFingerprint: 'f',
      profile: 'none',
      radiusMetres: 500,
      teleportCost: 20,
      terrainTier: 'B',
      dungeonInteriors: true,
      minDegree: 3,
    };
    const a = cacheKey({ ...base, unlockedBeacons: ['x'] });
    const b = cacheKey({ ...base, unlockedBeacons: ['x', 'y'] });
    expect(a).not.toBe(b);
  });
});
