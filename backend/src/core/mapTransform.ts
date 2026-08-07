// World -> map coordinate transform, fitted by least squares from the
// correspondences in expectations.yaml.
//
//   swap-similarity (3 params) — axis swap, uniform scale, translation:
//     map_x = (world_y + ty) / s ,  map_y = (world_x + tx) / s
//   affine6 (6 params) — unconstrained, needs >= 3 correspondences.

export type TransformModel = 'swap-similarity' | 'affine6';

export interface Correspondence {
  label: string;
  world: { x: number; y: number };
  map: { x: number; y: number };
  tolerance?: number;
}

export interface FittedTransform {
  model: TransformModel;
  /** swap-similarity params; null for affine6. */
  similarity: { scale: number; tx: number; ty: number } | null;
  /** affine6 params [a,b,c,d,e,f]; null for swap-similarity. */
  affine: [number, number, number, number, number, number] | null;
  apply: (worldX: number, worldY: number) => { x: number; y: number };
  /** Residual (map units) at each correspondence used for the fit. */
  fitResiduals: { label: string; residual: number }[];
  maxFitResidual: number;
  rmsFitResidual: number;
}

export interface HoldoutReport {
  performed: boolean;
  reason?: string;
  results: { label: string; residual: number; tolerance: number; pass: boolean }[];
  maxResidual: number;
  pass: boolean;
}

/** Minimum correspondences required to fit each model. */
export function minPointsFor(model: TransformModel): number {
  return model === 'swap-similarity' ? 2 : 3;
}

/** Least-squares solve of `A x = b` via normal equations and Gaussian elimination. */
function lstsq(A: number[][], b: number[]): number[] {
  const rows = A.length;
  const n = A[0]?.length ?? 0;
  if (rows < n) throw new Error(`under-determined system: ${rows} equations, ${n} unknowns`);

  // Normal equations.
  const M: number[][] = Array.from({ length: n }, () => new Array<number>(n + 1).fill(0));
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      let s = 0;
      for (let r = 0; r < rows; r++) s += A[r]![i]! * A[r]![j]!;
      M[i]![j] = s;
    }
    let s = 0;
    for (let r = 0; r < rows; r++) s += A[r]![i]! * b[r]!;
    M[i]![n] = s;
  }

  // Gaussian elimination with partial pivoting.
  for (let col = 0; col < n; col++) {
    let piv = col;
    for (let r = col + 1; r < n; r++) {
      if (Math.abs(M[r]![col]!) > Math.abs(M[piv]![col]!)) piv = r;
    }
    if (Math.abs(M[piv]![col]!) < 1e-12) {
      throw new Error(
        'singular calibration system — correspondences are degenerate ' +
          '(collinear or duplicated). Supply points spread across the map.',
      );
    }
    [M[col], M[piv]] = [M[piv]!, M[col]!];
    const p = M[col]![col]!;
    for (let j = col; j <= n; j++) M[col]![j]! /= p;
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = M[r]![col]!;
      if (f === 0) continue;
      for (let j = col; j <= n; j++) M[r]![j]! -= f * M[col]![j]!;
    }
  }

  return Array.from({ length: n }, (_, i) => M[i]![n]!);
}

function buildApply(
  model: TransformModel,
  similarity: { scale: number; tx: number; ty: number } | null,
  affine: [number, number, number, number, number, number] | null,
) {
  if (model === 'swap-similarity') {
    const { scale, tx, ty } = similarity!;
    return (wx: number, wy: number) => ({
      x: (wy + ty) / scale,
      y: (wx + tx) / scale,
    });
  }
  const [a, b, c, d, e, f] = affine!;
  return (wx: number, wy: number) => ({
    x: a * wx + b * wy + c,
    y: d * wx + e * wy + f,
  });
}

export function fitTransform(
  points: Correspondence[],
  model: TransformModel = 'swap-similarity',
): FittedTransform {
  const need = minPointsFor(model);
  if (points.length < need) {
    throw new Error(
      `${model} needs at least ${need} correspondence(s); got ${points.length}. ` +
        `Add entries under \`calibration:\` in data/expectations.yaml.`,
    );
  }

  let similarity: { scale: number; tx: number; ty: number } | null = null;
  let affine: [number, number, number, number, number, number] | null = null;

  if (model === 'swap-similarity') {
    // Unknowns [s, tx, ty]:
    //   map_x * s          - ty = world_y
    //   map_y * s  - tx          = world_x
    const A: number[][] = [];
    const b: number[] = [];
    for (const p of points) {
      A.push([p.map.x, 0, -1]);
      b.push(p.world.y);
      A.push([p.map.y, -1, 0]);
      b.push(p.world.x);
    }
    const [s, tx, ty] = lstsq(A, b) as [number, number, number];
    similarity = { scale: s, tx, ty };
  } else {
    // map_x = a*wx + b*wy + c   /   map_y = d*wx + e*wy + f
    const Ax: number[][] = [];
    const bx: number[] = [];
    const Ay: number[][] = [];
    const by: number[] = [];
    for (const p of points) {
      Ax.push([p.world.x, p.world.y, 1]);
      bx.push(p.map.x);
      Ay.push([p.world.x, p.world.y, 1]);
      by.push(p.map.y);
    }
    const [a, b2, c] = lstsq(Ax, bx) as [number, number, number];
    const [d, e, f] = lstsq(Ay, by) as [number, number, number];
    affine = [a, b2, c, d, e, f];
  }

  const apply = buildApply(model, similarity, affine);
  const fitResiduals = points.map((p) => {
    const got = apply(p.world.x, p.world.y);
    return { label: p.label, residual: Math.hypot(got.x - p.map.x, got.y - p.map.y) };
  });
  const maxFitResidual = fitResiduals.reduce((m, r) => Math.max(m, r.residual), 0);
  const rms = Math.sqrt(
    fitResiduals.reduce((s, r) => s + r.residual * r.residual, 0) /
      Math.max(fitResiduals.length, 1),
  );

  return {
    model,
    similarity,
    affine,
    apply,
    fitResiduals,
    maxFitResidual,
    rmsFitResidual: rms,
  };
}

/**
 * Leave-one-out check: fit on N-1 points, measure error at the excluded one.
 */
export function holdoutValidate(
  points: Correspondence[],
  model: TransformModel = 'swap-similarity',
  defaultTolerance = 2,
): HoldoutReport {
  const need = minPointsFor(model);
  if (points.length < need + 1) {
    return {
      performed: false,
      reason:
        `Hold-out validation needs at least ${need + 1} correspondences for ` +
        `model "${model}" (${need} to fit, 1 to hold out); only ${points.length} ` +
        `configured. The fit residual below is an in-sample number and does NOT ` +
        `demonstrate the transform generalises. Add another calibration point ` +
        `to data/expectations.yaml to enable a real hold-out check.`,
      results: [],
      maxResidual: Number.NaN,
      pass: false,
    };
  }

  const results = points.map((held, i) => {
    const rest = points.filter((_, j) => j !== i);
    const fit = fitTransform(rest, model);
    const got = fit.apply(held.world.x, held.world.y);
    const residual = Math.hypot(got.x - held.map.x, got.y - held.map.y);
    const tolerance = held.tolerance ?? defaultTolerance;
    return { label: held.label, residual, tolerance, pass: residual <= tolerance };
  });

  return {
    performed: true,
    results,
    maxResidual: results.reduce((m, r) => Math.max(m, r.residual), 0),
    pass: results.every((r) => r.pass),
  };
}
