import fs from 'node:fs/promises';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { ProfilesFileSchema, type MovementProfile, type ProfilesFile } from '../types.js';
import { EXPECTATIONS_PATH, PROFILES_PATH } from './paths.js';

// Default API address, shared by the server and the CLI.
export const DEFAULT_PORT = 6969;
export const DEFAULT_HOST = '127.0.0.1';

const CountRangeSchema = z.object({
  min: z.number().int().nonnegative(),
  max: z.number().int().nonnegative(),
  /** Set when a zero count is expected rather than a failure. */
  gap_reason: z.string().optional(),
});
export type CountRange = z.infer<typeof CountRangeSchema>;

export const ExpectationsSchema = z.object({
  game_version: z.string(),
  world_bounds: z.object({
    min_x: z.number(),
    max_x: z.number(),
    min_y: z.number(),
    max_y: z.number(),
    min_z: z.number(),
    max_z: z.number(),
  }),
  counts_by_kind: z.record(z.string(), CountRangeSchema),
  duplicate_radius_metres: z.record(z.string(), z.number().nonnegative()),
  min_biome_coverage: z.number().min(0).max(1),
  max_z_estimated_fraction: z.number().min(0).max(1),
  calibration: z
    .array(
      z.object({
        label: z.string(),
        world: z.object({ x: z.number(), y: z.number() }),
        map: z.object({ x: z.number(), y: z.number() }),
        tolerance: z.number().positive().optional(),
      }),
    )
    .default([]),
});
export type Expectations = z.infer<typeof ExpectationsSchema>;

export async function loadExpectations(p = EXPECTATIONS_PATH): Promise<Expectations> {
  const raw = parseYaml(await fs.readFile(p, 'utf8')) as unknown;
  return ExpectationsSchema.parse(raw);
}

export async function loadProfiles(p = PROFILES_PATH): Promise<ProfilesFile> {
  const raw = parseYaml(await fs.readFile(p, 'utf8')) as unknown;
  return ProfilesFileSchema.parse(raw);
}

export function getProfile(file: ProfilesFile, name?: string): MovementProfile {
  const want = name ?? file.default_profile;
  const found = file.profiles.find((p) => p.name === want);
  if (!found) {
    throw new Error(
      `Unknown movement profile "${want}". Available: ${file.profiles.map((p) => p.name).join(', ')}`,
    );
  }
  return found;
}

export function dungeonCost(file: ProfilesFile, archetype: string): number {
  return (
    file.dungeon_enter_cost_seconds[archetype] ??
    file.dungeon_enter_cost_seconds['default'] ??
    180
  );
}
