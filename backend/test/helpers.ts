import type { Poi, PoiKind, ProfilesFile } from '../src/types.js';

/** Metres -> Unreal units (1 uu = 1 cm). */
export const m = (v: number): number => v * 100;

let seq = 0;

export function poi(
  id: string,
  kind: PoiKind,
  xMetres: number,
  yMetres: number,
  zMetres = 0,
  extra: Partial<Poi> = {},
): Poi {
  seq++;
  return {
    poi_id: id,
    kind,
    name: extra.name ?? id,
    class_id: extra.class_id ?? null,
    level_id: extra.level_id ?? 'overworld',
    biome: extra.biome ?? null,
    world_x: m(xMetres),
    world_y: m(yMetres),
    world_z: extra.world_z === undefined ? m(zMetres) : extra.world_z,
    z_estimated: extra.z_estimated ?? false,
    requires: extra.requires ?? [],
    boss_level: extra.boss_level ?? null,
    respawn_kind: extra.respawn_kind ?? 'static',
    source: extra.source ?? `fixture:${seq}`,
  };
}

/** Fixed profiles for fixtures, independent of profiles.yaml. */
export const testProfiles: ProfilesFile = {
  default_profile: 'none',
  teleport_cost_seconds: 20,
  map_open_cost_seconds: 3,
  dungeon_enter_cost_seconds: { default: 180, dungeon: 180, tower: 240 },
  profiles: [
    {
      name: 'none',
      description: 'on foot',
      v_ground: 5.5,
      v_climb: 1.6,
      v_glide: 7,
      v_swim: 2.2,
      v_mount: null,
      water_penalty: 1.6,
      can_fly: false,
      speed_source: 'fixture',
    },
    {
      name: 'jetragon',
      description: 'fast flyer',
      v_ground: 6,
      v_climb: 4,
      v_glide: 12,
      v_swim: 2.4,
      v_mount: 28,
      water_penalty: 1,
      can_fly: true,
      speed_source: 'fixture',
    },
  ],
};

/**
 * Beacons 10 m from start and target, 400 m apart. On foot the teleport wins
 * (23.6 s vs 72.7 s); flying it loses (20.7 s vs 14.3 s).
 */
export function teleportVsWalkFixture(): Poi[] {
  return [
    poi('start', 'effigy', 0, 0),
    poi('beacon_near_start', 'fast_travel', 10, 0),
    poi('beacon_near_target', 'fast_travel', 390, 0),
    poi('target', 'alpha_boss', 400, 0),
  ];
}

/** Walking must win: target 100 m away, nearest beacon 2 km off. */
export function walkWinsFixture(): Poi[] {
  return [
    poi('start', 'effigy', 0, 0),
    poi('target', 'alpha_boss', 100, 0),
    poi('beacon_far', 'fast_travel', 2000, 0),
    poi('beacon_far2', 'fast_travel', 4000, 0),
  ];
}

/** Two clusters with no possible link, for unreachability tests. */
export function disconnectedFixture(): Poi[] {
  return [
    poi('a1', 'effigy', 0, 0),
    poi('a2', 'effigy', 10, 0),
    poi('a3', 'effigy', 20, 0),
    poi('b1', 'effigy', 0, 0, 0, { level_id: 'island_b' }),
    poi('b2', 'effigy', 10, 0, 0, { level_id: 'island_b' }),
    poi('b3', 'effigy', 20, 0, 0, { level_id: 'island_b' }),
  ];
}

/** Dungeon entrances and their interiors. */
export function dungeonFixture(): Poi[] {
  return [
    poi('beacon', 'fast_travel', 0, 0),
    poi('entrance_a', 'dungeon_entrance', 100, 0),
    poi('entrance_b', 'dungeon_entrance', 200, 0),
    poi('effigy_a', 'effigy', 150, 0),
  ];
}
