import { PoiSchema, type Dataset, type Poi } from '../types.js';
import type { Expectations } from '../core/config.js';
import { fitTransform, holdoutValidate, type Correspondence } from '../core/mapTransform.js';
import { SpatialHash } from '../graph/spatial.js';
import { UU_PER_METRE } from '../graph/cost.js';

// Dataset validation. The CLI exits non-zero when `ok` is false. Checks that
// cannot run are reported `skipped` with a reason.

export type CheckStatus = 'pass' | 'fail' | 'warn' | 'skipped';

export interface Check {
  id: string;
  status: CheckStatus;
  message: string;
  details?: string[];
}

export interface ValidationReport {
  ok: boolean;
  gameVersion: string;
  poiCount: number;
  countsByKind: Record<string, number>;
  countsByBiome: Record<string, number>;
  checks: Check[];
  /** Non-fatal notes carried through from the build step. */
  warnings: string[];
}

function tally<T>(items: T[], key: (t: T) => string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const it of items) {
    const k = key(it);
    out[k] = (out[k] ?? 0) + 1;
  }
  return out;
}

export function validateDataset(
  dataset: Dataset,
  exp: Expectations,
  opts: { warnings?: string[] } = {},
): ValidationReport {
  const checks: Check[] = [];
  const pois = dataset.pois;

  const countsByKind = tally(pois, (p) => p.kind);
  const countsByBiome = tally(pois, (p) => p.biome ?? '(none)');

  // -- schema conformance -------------------------------------------------
  {
    const bad: string[] = [];
    pois.forEach((p, i) => {
      const r = PoiSchema.safeParse(p);
      if (!r.success) {
        bad.push(
          `#${i} ${p.poi_id ?? '(no id)'}: ${r.error.issues
            .map((x) => `${x.path.join('.')} ${x.message}`)
            .join('; ')}`,
        );
      }
    });
    checks.push({
      id: 'schema',
      status: bad.length === 0 ? 'pass' : 'fail',
      message:
        bad.length === 0
          ? `All ${pois.length} POIs conform to the unified schema.`
          : `${bad.length} POI(s) violate the unified schema.`,
      details: bad.slice(0, 20),
    });
  }

  // -- every POI has a source, an id, and real coordinates ----------------
  {
    const noSource = pois.filter((p) => !p.source);
    const nullCoords = pois.filter(
      (p) => !Number.isFinite(p.world_x) || !Number.isFinite(p.world_y),
    );
    const ids = new Set<string>();
    const dupIds: string[] = [];
    for (const p of pois) {
      if (ids.has(p.poi_id)) dupIds.push(p.poi_id);
      ids.add(p.poi_id);
    }
    const problems: string[] = [];
    if (noSource.length) problems.push(`${noSource.length} POI(s) missing \`source\``);
    if (nullCoords.length) problems.push(`${nullCoords.length} POI(s) with null/NaN x or y`);
    if (dupIds.length) problems.push(`${dupIds.length} duplicate poi_id(s): ${dupIds.slice(0, 5).join(', ')}`);
    checks.push({
      id: 'provenance-and-identity',
      status: problems.length === 0 ? 'pass' : 'fail',
      message:
        problems.length === 0
          ? 'Every POI carries a source, a unique id, and finite coordinates.'
          : problems.join('; '),
    });
  }

  // -- counts per kind vs expectations ------------------------------------
  {
    const failures: string[] = [];
    const notes: string[] = [];
    for (const [kind, range] of Object.entries(exp.counts_by_kind)) {
      const n = countsByKind[kind] ?? 0;
      if (n === 0 && range.gap_reason) {
        notes.push(`${kind}: 0 — declared gap. ${range.gap_reason.trim()}`);
        continue;
      }
      if (n < range.min || n > range.max) {
        failures.push(`${kind}: ${n} outside expected ${range.min}..${range.max}`);
      }
    }
    // Kinds present in the data but absent from expectations.yaml.
    const unexpected = Object.keys(countsByKind).filter(
      (k) => !(k in exp.counts_by_kind),
    );
    if (unexpected.length) {
      notes.push(`kinds present but not listed in expectations.yaml: ${unexpected.join(', ')}`);
    }
    checks.push({
      id: 'counts-by-kind',
      status: failures.length === 0 ? 'pass' : 'fail',
      message:
        failures.length === 0
          ? `Per-kind counts within expected ranges (${Object.keys(countsByKind).length} kinds present).`
          : `${failures.length} kind(s) outside expected range.`,
      details: [...failures, ...notes],
    });
  }

  // -- bounds -------------------------------------------------------------
  {
    const b = exp.world_bounds;
    const out: string[] = [];
    for (const p of pois) {
      if (p.world_x < b.min_x || p.world_x > b.max_x) out.push(`${p.poi_id}: x=${p.world_x}`);
      else if (p.world_y < b.min_y || p.world_y > b.max_y) out.push(`${p.poi_id}: y=${p.world_y}`);
      else if (p.world_z !== null && (p.world_z < b.min_z || p.world_z > b.max_z))
        out.push(`${p.poi_id}: z=${p.world_z}`);
    }
    checks.push({
      id: 'bounds',
      status: out.length === 0 ? 'pass' : 'fail',
      message:
        out.length === 0
          ? 'All coordinates inside declared world extents.'
          : `${out.length} POI(s) outside world extents — likely a map-space/world-space mixup.`,
      details: out.slice(0, 20),
    });
  }

  // -- duplicate detection ------------------------------------------------
  {
    const dupes: string[] = [];
    const byKind = new Map<string, Poi[]>();
    for (const p of pois) {
      const arr = byKind.get(p.kind) ?? [];
      arr.push(p);
      byKind.set(p.kind, arr);
    }
    for (const [kind, group] of byKind) {
      const radiusM =
        exp.duplicate_radius_metres[kind] ?? exp.duplicate_radius_metres['default'] ?? 25;
      const radiusUU = radiusM * UU_PER_METRE;
      const hash = new SpatialHash(radiusUU);
      group.forEach((p, i) => hash.insert(i, p.world_x, p.world_y));
      const reported = new Set<string>();
      group.forEach((p, i) => {
        for (const j of hash.query(p.world_x, p.world_y, radiusUU)) {
          if (j <= i) continue;
          const q = group[j]!;
          const d = Math.hypot(p.world_x - q.world_x, p.world_y - q.world_y);
          if (d <= radiusUU) {
            const key = `${p.poi_id}|${q.poi_id}`;
            if (!reported.has(key)) {
              reported.add(key);
              dupes.push(
                `${kind}: ${p.poi_id} and ${q.poi_id} are ${(d / UU_PER_METRE).toFixed(1)} m apart (< ${radiusM} m)`,
              );
            }
          }
        }
      });
    }
    checks.push({
      id: 'duplicates',
      // Warns rather than fails; near-coincident POIs can be legitimate.
      status: dupes.length === 0 ? 'pass' : 'warn',
      message:
        dupes.length === 0
          ? 'No same-kind POIs closer than their duplicate radius.'
          : `${dupes.length} suspiciously close same-kind pair(s) — possible double import.`,
      details: dupes.slice(0, 20),
    });
  }

  // -- layer / orphan checks ----------------------------------------------
  {
    const levels = new Set(pois.map((p) => p.level_id));
    const problems: string[] = [];
    const nonOverworld = [...levels].filter((l) => l !== 'overworld');

    // Every non-overworld layer needs a dungeon_entrance naming it.
    const entranceTargets = new Set(
      pois
        .filter((p) => p.kind === 'dungeon_entrance')
        .map((p) => `dungeon:${p.poi_id}`),
    );
    for (const lvl of nonOverworld) {
      const reachable =
        entranceTargets.has(lvl) ||
        pois.some((p) => p.kind === 'dungeon_entrance' && lvl.startsWith(`dungeon:${p.poi_id}`));
      if (!reachable) {
        problems.push(`level_id "${lvl}" has no dungeon_entrance leading into it`);
      }
    }
    checks.push({
      id: 'layer-orphans',
      status: problems.length === 0 ? 'pass' : 'fail',
      message:
        problems.length === 0
          ? `Layer graph consistent (${levels.size} layer(s); ${nonOverworld.length} non-overworld).`
          : `${problems.length} orphaned layer(s).`,
      details: problems.slice(0, 20),
    });
  }

  // -- biome coverage -----------------------------------------------------
  {
    const withBiome = pois.filter((p) => p.biome !== null).length;
    const frac = pois.length === 0 ? 0 : withBiome / pois.length;
    checks.push({
      id: 'biome-coverage',
      status: frac >= exp.min_biome_coverage ? 'pass' : 'warn',
      message:
        `${(frac * 100).toFixed(1)}% of POIs carry a biome ` +
        `(threshold ${(exp.min_biome_coverage * 100).toFixed(0)}%). ` +
        `Biomes are derived from spawner-id tokens, not authoritative metadata.`,
    });
  }

  // -- estimated-Z fraction ----------------------------------------------
  {
    const est = pois.filter((p) => p.z_estimated).length;
    const frac = pois.length === 0 ? 0 : est / pois.length;
    checks.push({
      id: 'z-coverage',
      status: frac <= exp.max_z_estimated_fraction ? 'pass' : 'fail',
      message:
        `${est}/${pois.length} POI(s) (${(frac * 100).toFixed(1)}%) have no source Z ` +
        `and are flagged z_estimated (limit ${(exp.max_z_estimated_fraction * 100).toFixed(0)}%). ` +
        `Edges touching these drop the climb/glide term and are marked estimated.`,
    });
  }

  // -- coordinate-system sanity via the fitted map transform --------------
  {
    const pts: Correspondence[] = exp.calibration.map((c) => ({
      label: c.label,
      world: c.world,
      map: c.map,
      tolerance: c.tolerance,
    }));

    if (pts.length < 2) {
      checks.push({
        id: 'coordinate-calibration',
        status: 'skipped',
        message:
          `Only ${pts.length} calibration point(s) configured; need >= 2 to fit a ` +
          `transform. Coordinate-system sanity is UNVERIFIED. Add points under ` +
          `\`calibration:\` in data/expectations.yaml.`,
      });
    } else {
      try {
        const fit = fitTransform(pts, 'swap-similarity');
        const holdout = holdoutValidate(pts, 'swap-similarity');
        const details = [
          `fitted scale=${fit.similarity!.scale.toFixed(3)} ` +
            `tx=${fit.similarity!.tx.toFixed(1)} ty=${fit.similarity!.ty.toFixed(1)} ` +
            `(fitted from data, not hardcoded)`,
          `in-sample residuals: ${fit.fitResiduals
            .map((r) => `${r.label}=${r.residual.toFixed(3)}`)
            .join(', ')} (rms ${fit.rmsFitResidual.toFixed(3)})`,
        ];
        if (holdout.performed) {
          details.push(
            `leave-one-out: ${holdout.results
              .map((r) => `${r.label}=${r.residual.toFixed(3)}/${r.tolerance}`)
              .join(', ')}`,
          );
        } else {
          details.push(`hold-out NOT performed: ${holdout.reason}`);
        }

        const tol = Math.min(...pts.map((p) => p.tolerance ?? 2));
        const inSampleOk = fit.maxFitResidual <= tol;
        checks.push({
          id: 'coordinate-calibration',
          // Passes only with a hold-out point; otherwise warns.
          status: inSampleOk ? (holdout.performed && holdout.pass ? 'pass' : 'warn') : 'fail',
          message: inSampleOk
            ? holdout.performed && holdout.pass
              ? `Transform fits and generalises; max hold-out residual ${holdout.maxResidual.toFixed(3)} map units.`
              : `Transform fits in-sample (max residual ${fit.maxFitResidual.toFixed(3)} map units), but generalisation is unverified.`
            : `Transform does not reproduce its own calibration points (max residual ${fit.maxFitResidual.toFixed(3)} > ${tol}). Coordinates are probably in the wrong space.`,
          details,
        });
      } catch (err) {
        checks.push({
          id: 'coordinate-calibration',
          status: 'fail',
          message: `Calibration fit failed: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    }
  }

  // -- game version -------------------------------------------------------
  {
    const match = dataset.game_version === exp.game_version;
    checks.push({
      id: 'game-version',
      status: match ? 'pass' : 'warn',
      message: match
        ? `Dataset game version "${dataset.game_version}" matches expectations.`
        : `VERSION MISMATCH: dataset is "${dataset.game_version}" but expectations.yaml ` +
          `declares "${exp.game_version}". Counts and coordinates may be stale.`,
    });
  }

  return {
    ok: !checks.some((c) => c.status === 'fail'),
    gameVersion: dataset.game_version,
    poiCount: pois.length,
    countsByKind,
    countsByBiome,
    checks,
    warnings: opts.warnings ?? [],
  };
}

export function formatReport(r: ValidationReport, opts: { color?: boolean } = {}): string {
  const c = opts.color !== false;
  const dim = (s: string) => (c ? `\x1b[2m${s}\x1b[0m` : s);
  const bold = (s: string) => (c ? `\x1b[1m${s}\x1b[0m` : s);
  const mark: Record<CheckStatus, string> = {
    pass: c ? '\x1b[32mPASS\x1b[0m' : 'PASS',
    fail: c ? '\x1b[31mFAIL\x1b[0m' : 'FAIL',
    warn: c ? '\x1b[33mWARN\x1b[0m' : 'WARN',
    skipped: c ? '\x1b[36mSKIP\x1b[0m' : 'SKIP',
  };

  const lines: string[] = [];
  lines.push(bold(`palroute validate — ${r.poiCount} POIs, game version ${r.gameVersion}`));
  lines.push('');

  lines.push(bold('POIs by kind'));
  const kinds = Object.entries(r.countsByKind).sort((a, b) => b[1] - a[1]);
  const kw = Math.max(...kinds.map(([k]) => k.length), 4);
  for (const [k, n] of kinds) lines.push(`  ${k.padEnd(kw)}  ${String(n).padStart(5)}`);
  lines.push('');

  lines.push(bold('POIs by biome'));
  const biomes = Object.entries(r.countsByBiome).sort((a, b) => b[1] - a[1]);
  const bw = Math.max(...biomes.map(([k]) => k.length), 4);
  for (const [k, n] of biomes) lines.push(`  ${k.padEnd(bw)}  ${String(n).padStart(5)}`);
  lines.push('');

  lines.push(bold('Checks'));
  for (const ch of r.checks) {
    lines.push(`  [${mark[ch.status]}] ${ch.id}: ${ch.message}`);
    for (const d of ch.details ?? []) lines.push(dim(`         - ${d}`));
  }

  if (r.warnings.length) {
    lines.push('');
    lines.push(bold('Build notes'));
    for (const w of r.warnings) lines.push(dim(`  - ${w}`));
  }

  lines.push('');
  lines.push(
    r.ok
      ? c
        ? '\x1b[32mvalidation OK\x1b[0m'
        : 'validation OK'
      : c
        ? '\x1b[31mvalidation FAILED\x1b[0m'
        : 'validation FAILED',
  );
  return lines.join('\n');
}
