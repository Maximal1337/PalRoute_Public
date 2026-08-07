import fs from 'node:fs/promises';
import type { MovementProfile, Poi } from '../types.js';

/**
 * Terrain model. Tier A is A* over a rasterized heightmap and water mask;
 * Tier B is a straight line with a Z penalty, every edge flagged estimated.
 */
export interface TerrainProvider {
  readonly tier: 'A' | 'B';
  /** One-line description of the active tier. */
  describe(): string;
  /** True when the segment crosses water. Tier B cannot know, so returns false. */
  crossesWater(a: Poi, b: Poi): boolean;
  /** Modelled cost in seconds, or null to fall back to straight-line. Tier B always returns null. */
  pathSeconds(a: Poi, b: Poi, profile: MovementProfile): number | null;
  /** True when the two points are separated by impassable terrain. */
  isBlocked(a: Poi, b: Poi): boolean;
}

/** Tier B: no terrain data. Every method reports the absence. */
export class TierBTerrain implements TerrainProvider {
  readonly tier = 'B' as const;

  describe(): string {
    return (
      'Tier B — no heightmap or water mask. Distances are straight lines with a ' +
      'Z penalty; cliffs, coastlines and islands are NOT modelled.'
    );
  }

  crossesWater(): boolean {
    return false;
  }

  pathSeconds(): number | null {
    return null;
  }

  isBlocked(): boolean {
    return false;
  }
}

export interface HeightmapGrid {
  /** Grid resolution in metres per cell. */
  cellMetres: number;
  width: number;
  height: number;
  /** World-space origin (Unreal units) of cell (0,0). */
  originX: number;
  originY: number;
  /** Elevation per cell, metres. Length = width*height. */
  elevation: Float32Array;
  /** 1 = water, 0 = land. Length = width*height. */
  water: Uint8Array;
  /** 1 = impassable, 0 = passable. Length = width*height. */
  blocked: Uint8Array;
}

/** Loads a Tier A grid: a JSON sidecar plus raw binary elevation, water and blocked planes. */
export async function loadHeightmap(jsonPath: string): Promise<HeightmapGrid> {
  const meta = JSON.parse(await fs.readFile(jsonPath, 'utf8')) as {
    cellMetres: number;
    width: number;
    height: number;
    originX: number;
    originY: number;
    elevationFile: string;
    waterFile: string;
    blockedFile?: string;
  };

  const dir = jsonPath.replace(/[^/\\]+$/, '');
  const n = meta.width * meta.height;
  const elevBuf = await fs.readFile(dir + meta.elevationFile);
  const waterBuf = await fs.readFile(dir + meta.waterFile);
  const blockedBuf = meta.blockedFile
    ? await fs.readFile(dir + meta.blockedFile)
    : Buffer.alloc(n);

  if (elevBuf.byteLength < n * 4) {
    throw new Error(
      `heightmap elevation plane too small: expected ${n * 4} bytes for ` +
        `${meta.width}x${meta.height} float32, got ${elevBuf.byteLength}`,
    );
  }

  return {
    cellMetres: meta.cellMetres,
    width: meta.width,
    height: meta.height,
    originX: meta.originX,
    originY: meta.originY,
    elevation: new Float32Array(
      elevBuf.buffer,
      elevBuf.byteOffset,
      n,
    ),
    water: new Uint8Array(waterBuf.buffer, waterBuf.byteOffset, n),
    blocked: new Uint8Array(blockedBuf.buffer, blockedBuf.byteOffset, n),
  };
}

/** Tier A: A* over the rasterized grid, cached per POI pair. Requires a real grid. */
export class TierATerrain implements TerrainProvider {
  readonly tier = 'A' as const;
  private readonly cache = new Map<string, number | null>();

  constructor(private readonly grid: HeightmapGrid) {}

  describe(): string {
    return (
      `Tier A — ${this.grid.width}x${this.grid.height} grid at ` +
      `${this.grid.cellMetres} m/cell with slope and water mask; A* path costs.`
    );
  }

  private cellIndex(worldX: number, worldY: number): number | null {
    const cellUU = this.grid.cellMetres * 100;
    const cx = Math.floor((worldX - this.grid.originX) / cellUU);
    const cy = Math.floor((worldY - this.grid.originY) / cellUU);
    if (cx < 0 || cy < 0 || cx >= this.grid.width || cy >= this.grid.height) return null;
    return cy * this.grid.width + cx;
  }

  crossesWater(a: Poi, b: Poi): boolean {
    // Sample along the segment; any wet cell counts.
    const steps = 32;
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const x = a.world_x + (b.world_x - a.world_x) * t;
      const y = a.world_y + (b.world_y - a.world_y) * t;
      const idx = this.cellIndex(x, y);
      if (idx !== null && this.grid.water[idx] === 1) return true;
    }
    return false;
  }

  isBlocked(a: Poi, b: Poi): boolean {
    return this.pathSeconds(a, b, null as unknown as MovementProfile) === null;
  }

  pathSeconds(a: Poi, b: Poi, profile: MovementProfile): number | null {
    const key = `${a.poi_id}|${b.poi_id}|${profile?.name ?? '-'}`;
    const hit = this.cache.get(key);
    if (hit !== undefined) return hit;
    const result = this.astar(a, b, profile);
    this.cache.set(key, result);
    return result;
  }

  /** 8-connected A* with a slope-aware step cost. Null when no route exists. */
  private astar(a: Poi, b: Poi, profile: MovementProfile): number | null {
    const start = this.cellIndex(a.world_x, a.world_y);
    const goal = this.cellIndex(b.world_x, b.world_y);
    if (start === null || goal === null) return null;
    if (start === goal) return 0;

    const { width, height, elevation, water, blocked, cellMetres } = this.grid;
    const gScore = new Map<number, number>([[start, 0]]);
    const open: { idx: number; f: number }[] = [{ idx: start, f: 0 }];
    const closed = new Set<number>();
    const goalX = goal % width;
    const goalY = Math.floor(goal / width);
    const vGround = profile?.v_ground ?? 5;
    const vClimb = profile?.v_climb ?? 1.5;
    const vGlide = profile?.v_glide ?? 6;
    const vSwim = profile?.v_swim ?? 2;
    const waterPenalty = profile?.water_penalty ?? 1.5;

    const heuristic = (idx: number): number => {
      const dx = (idx % width) - goalX;
      const dy = Math.floor(idx / width) - goalY;
      return (Math.hypot(dx, dy) * cellMetres) / Math.max(vGround, vSwim);
    };

    // Expansion budget, to bound worst-case search time.
    let expansions = 0;
    const budget = 400_000;

    while (open.length > 0) {
      open.sort((p, q) => p.f - q.f);
      const cur = open.shift()!;
      if (cur.idx === goal) return gScore.get(goal) ?? null;
      if (closed.has(cur.idx)) continue;
      closed.add(cur.idx);
      if (++expansions > budget) return null;

      const cx = cur.idx % width;
      const cy = Math.floor(cur.idx / width);
      const g = gScore.get(cur.idx) ?? Infinity;

      for (let ddy = -1; ddy <= 1; ddy++) {
        for (let ddx = -1; ddx <= 1; ddx++) {
          if (ddx === 0 && ddy === 0) continue;
          const nx = cx + ddx;
          const ny = cy + ddy;
          if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
          const nIdx = ny * width + nx;
          if (blocked[nIdx] === 1 || closed.has(nIdx)) continue;

          const horiz = Math.hypot(ddx, ddy) * cellMetres;
          const dz = (elevation[nIdx] ?? 0) - (elevation[cur.idx] ?? 0);
          let step: number;
          if (water[nIdx] === 1) {
            step = (horiz / vSwim) * waterPenalty;
          } else {
            step = horiz / vGround + (dz > 0 ? dz / vClimb : -dz / vGlide);
          }

          const tentative = g + step;
          if (tentative < (gScore.get(nIdx) ?? Infinity)) {
            gScore.set(nIdx, tentative);
            open.push({ idx: nIdx, f: tentative + heuristic(nIdx) });
          }
        }
      }
    }
    return null;
  }
}

/** Pick a terrain provider, falling back to Tier B. The note records which was used. */
export async function resolveTerrain(
  heightmapPath?: string,
): Promise<{ provider: TerrainProvider; note: string }> {
  if (!heightmapPath) {
    const provider = new TierBTerrain();
    return { provider, note: provider.describe() };
  }
  try {
    const grid = await loadHeightmap(heightmapPath);
    const provider = new TierATerrain(grid);
    return { provider, note: provider.describe() };
  } catch (err) {
    const provider = new TierBTerrain();
    return {
      provider,
      note:
        `${provider.describe()} (Tier A requested but failed to load ` +
        `${heightmapPath}: ${err instanceof Error ? err.message : String(err)})`,
    };
  }
}
