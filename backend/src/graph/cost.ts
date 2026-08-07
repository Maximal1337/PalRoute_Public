import type { EdgeMode, MovementProfile, Poi } from '../types.js';

/** 1 Unreal unit = 1 cm. */
export const UU_PER_METRE = 100;

export function metres(uu: number): number {
  return uu / UU_PER_METRE;
}

export interface CostBreakdown {
  seconds: number;
  mode: EdgeMode;
  /** Horizontal component, metres. */
  horizontalM: number;
  /** Signed vertical component, metres (positive = climb). */
  verticalM: number;
  estimated: boolean;
  note?: string;
  /** Per-term seconds, surfaced in JSON output. */
  terms: {
    ground?: number;
    climb?: number;
    glide?: number;
    swim?: number;
    flight?: number;
  };
}

export interface CostContext {
  profile: MovementProfile;
  /** Tier A supplies real terrain; Tier B is straight-line. */
  terrainTier: 'A' | 'B';
  /** True when the segment crosses water. Always false under Tier B, which has no water mask. */
  crossesWater?: (a: Poi, b: Poi) => boolean;
}

/**
 * Travel cost between two POIs, in seconds. A missing source Z drops the
 * vertical term and flags the edge estimated.
 */
export function travelCost(a: Poi, b: Poi, ctx: CostContext): CostBreakdown {
  const { profile } = ctx;
  const dxUU = b.world_x - a.world_x;
  const dyUU = b.world_y - a.world_y;
  const horizontalM = metres(Math.hypot(dxUU, dyUU));

  const zUnknown = a.world_z === null || b.world_z === null || a.z_estimated || b.z_estimated;
  const verticalM = zUnknown ? 0 : metres((b.world_z ?? 0) - (a.world_z ?? 0));

  const notes: string[] = [];
  if (zUnknown) notes.push('no source Z: vertical term dropped');
  if (ctx.terrainTier === 'B') notes.push('Tier B: straight line, terrain not modelled');

  // Flying: 3D straight line, terrain irrelevant.
  if (profile.can_fly && profile.v_mount) {
    const dist3d = Math.hypot(horizontalM, verticalM);
    const flight = dist3d / profile.v_mount;
    return {
      seconds: flight,
      mode: 'fly',
      horizontalM,
      verticalM,
      // Flight edges are only estimated when Z is missing.
      estimated: zUnknown,
      note: notes.length ? notes.join('; ') : undefined,
      terms: { flight },
    };
  }

  const water = ctx.crossesWater?.(a, b) ?? false;
  if (water) {
    const swim = (horizontalM / profile.v_swim) * profile.water_penalty;
    return {
      seconds: swim,
      mode: 'swim',
      horizontalM,
      verticalM,
      estimated: ctx.terrainTier === 'B' || zUnknown,
      note: notes.length ? notes.join('; ') : undefined,
      terms: { swim },
    };
  }

  const ground = horizontalM / profile.v_ground;
  const climb = verticalM > 0 ? verticalM / profile.v_climb : 0;
  const glide = verticalM < 0 ? -verticalM / profile.v_glide : 0;

  return {
    seconds: ground + climb + glide,
    mode: 'walk',
    horizontalM,
    verticalM,
    estimated: ctx.terrainTier === 'B' || zUnknown,
    note: notes.length ? notes.join('; ') : undefined,
    terms: { ground, climb, glide },
  };
}

/** Straight-line 3D distance in metres, ignoring any traversal model. */
export function distanceMetres(a: Poi, b: Poi): number {
  const dx = metres(b.world_x - a.world_x);
  const dy = metres(b.world_y - a.world_y);
  const dz =
    a.world_z === null || b.world_z === null ? 0 : metres((b.world_z ?? 0) - (a.world_z ?? 0));
  return Math.hypot(dx, dy, dz);
}
