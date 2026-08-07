import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { Edge, Graph, Poi } from '../types.js';
import { CACHE_DIR } from './paths.js';

// Graph cache: one JSON file per key, keyed by every input that changes graph
// topology.

export interface CacheKeyParts {
  datasetFingerprint: string;
  profile: string;
  radiusMetres: number;
  teleportCost: number;
  terrainTier: string;
  unlockedBeacons: string[];
  dungeonInteriors: boolean;
  minDegree: number;
}

export function cacheKey(parts: CacheKeyParts): string {
  const canonical = JSON.stringify({
    ...parts,
    // Order must not affect the key.
    unlockedBeacons: [...parts.unlockedBeacons].sort(),
  });
  return createHash('sha256').update(canonical).digest('hex').slice(0, 32);
}

/** Fingerprint a POI set so dataset edits invalidate the cache. */
export function fingerprintPois(pois: Poi[], gameVersion: string): string {
  const h = createHash('sha256');
  h.update(gameVersion);
  h.update(String(pois.length));
  for (const p of pois) {
    h.update(`${p.poi_id}|${p.world_x}|${p.world_y}|${p.world_z}|${p.kind}|${p.level_id}`);
  }
  return h.digest('hex').slice(0, 32);
}

interface SerializedGraph {
  version: number;
  nodes: Poi[];
  adj: Edge[][];
  meta: Graph['meta'];
}

const CACHE_VERSION = 1;

/** Cache ceiling. Entries are evicted once either limit is exceeded. */
const MAX_CACHE_BYTES = Number(process.env['PALROUTE_CACHE_MAX_BYTES'] ?? 256 * 1024 * 1024);
const MAX_CACHE_FILES = Number(process.env['PALROUTE_CACHE_MAX_FILES'] ?? 64);

function cachePath(key: string): string {
  return path.join(CACHE_DIR, `graph-${key}.json`);
}

export async function readGraphCache(key: string): Promise<Graph | null> {
  try {
    const p = cachePath(key);
    const raw = await fs.readFile(p, 'utf8');
    const parsed = JSON.parse(raw) as SerializedGraph;
    if (parsed.version !== CACHE_VERSION) return null;
    // Touch the file so eviction is by last use.
    const now = new Date();
    fs.utimes(p, now, now).catch(() => {});
    const index = new Map<string, number>();
    parsed.nodes.forEach((n, i) => index.set(n.poi_id, i));
    return { nodes: parsed.nodes, adj: parsed.adj, index, meta: parsed.meta };
  } catch {
    return null;
  }
}

/**
 * Drop least-recently-used entries until the directory is inside both limits.
 * Returns how many files were removed.
 */
export async function pruneGraphCache(
  maxBytes = MAX_CACHE_BYTES,
  maxFiles = MAX_CACHE_FILES,
  dir = CACHE_DIR,
): Promise<number> {
  try {
    const names = (await fs.readdir(dir)).filter(
      (f) => f.startsWith('graph-') && f.endsWith('.json'),
    );

    const entries = (
      await Promise.all(
        names.map(async (f) => {
          const full = path.join(dir, f);
          try {
            const st = await fs.stat(full);
            return { full, bytes: st.size, used: st.mtimeMs };
          } catch {
            return null;
          }
        }),
      )
    ).filter((e): e is { full: string; bytes: number; used: number } => e !== null);

    // Newest first; the tail is dropped.
    entries.sort((a, b) => b.used - a.used);

    let keptBytes = 0;
    let keptFiles = 0;
    let removed = 0;

    for (const e of entries) {
      keptBytes += e.bytes;
      keptFiles += 1;
      if (keptFiles <= maxFiles && keptBytes <= maxBytes) continue;
      try {
        await fs.unlink(e.full);
        removed++;
      } catch {
        // Already removed by another process.
        keptBytes -= e.bytes;
        keptFiles -= 1;
      }
    }
    return removed;
  } catch {
    return 0;
  }
}

export async function writeGraphCache(key: string, graph: Graph): Promise<void> {
  try {
    await fs.mkdir(CACHE_DIR, { recursive: true });
    const payload: SerializedGraph = {
      version: CACHE_VERSION,
      nodes: graph.nodes,
      adj: graph.adj,
      meta: graph.meta,
    };
    await fs.writeFile(cachePath(key), JSON.stringify(payload), 'utf8');
    await pruneGraphCache();
  } catch {
    // Cache failures are non-fatal.
  }
}

export async function clearGraphCache(): Promise<number> {
  try {
    const files = await fs.readdir(CACHE_DIR);
    let n = 0;
    for (const f of files) {
      if (f.startsWith('graph-') && f.endsWith('.json')) {
        await fs.unlink(path.join(CACHE_DIR, f));
        n++;
      }
    }
    return n;
  } catch {
    return 0;
  }
}
