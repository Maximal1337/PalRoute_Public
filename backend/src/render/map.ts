import type { Expectations } from '../core/config.js';
import {
  fitTransform,
  holdoutValidate,
  type Correspondence,
  type FittedTransform,
  type HoldoutReport,
} from '../core/mapTransform.js';
import type { Poi, Route, TourResult } from '../types.js';

// Map overlay output: an SVG with a viewBox in map coordinates, for layering
// over a map image. The fitted transform's residual is written into both the
// SVG caption and the returned metadata.

export interface MapRenderResult {
  svg: string;
  transform: {
    model: string;
    params: Record<string, number>;
    max_fit_residual: number;
    rms_fit_residual: number;
    holdout: {
      performed: boolean;
      reason?: string;
      max_residual: number | null;
      pass: boolean;
      points: { label: string; residual: number; tolerance: number; pass: boolean }[];
    };
  };
  bounds: { minX: number; minY: number; maxX: number; maxY: number };
}

function correspondences(exp: Expectations): Correspondence[] {
  return exp.calibration.map((c) => ({
    label: c.label,
    world: c.world,
    map: c.map,
    tolerance: c.tolerance,
  }));
}

function esc(s: string): string {
  return s.replace(/[<>&"']/g, (ch) =>
    ch === '<' ? '&lt;' : ch === '>' ? '&gt;' : ch === '&' ? '&amp;' : ch === '"' ? '&quot;' : '&#39;',
  );
}

const MODE_STYLE: Record<string, { stroke: string; width: number; dash: string }> = {
  walk: { stroke: '#4b9fd5', width: 2, dash: '' },
  fly: { stroke: '#5fd35f', width: 2, dash: '' },
  swim: { stroke: '#3fc2c2', width: 2, dash: '4 3' },
  // Teleport legs are dashed and thicker than the rest.
  teleport: { stroke: '#c96bd8', width: 2.5, dash: '8 4' },
  portal: { stroke: '#e0a13a', width: 2.5, dash: '2 3' },
};

interface Segment {
  from: Poi;
  to: Poi;
  mode: string;
  estimated: boolean;
}

function segmentsFromRoute(route: Route): Segment[] {
  return route.legs.map((l) => ({
    from: l.from,
    to: l.to,
    mode: l.mode,
    estimated: l.estimated,
  }));
}

function segmentsFromTour(tour: TourResult): Segment[] {
  const segs: Segment[] = [];
  for (const r of tour.routes) if (r) segs.push(...segmentsFromRoute(r));
  if (segs.length === 0) {
    // Without per-leg routes, draw straight stop-to-stop links marked estimated.
    for (let i = 1; i < tour.stops.length; i++) {
      segs.push({
        from: tour.stops[i - 1]!.poi,
        to: tour.stops[i]!.poi,
        mode: 'walk',
        estimated: true,
      });
    }
  }
  return segs;
}

export function renderMap(
  input: { route?: Route | null; tour?: TourResult },
  exp: Expectations,
  opts: { markers?: Poi[]; title?: string; padding?: number } = {},
): MapRenderResult {
  const pts = correspondences(exp);
  if (pts.length < 2) {
    throw new Error(
      `Map output needs at least 2 calibration correspondences to fit a ` +
        `transform; expectations.yaml has ${pts.length}. Add entries under ` +
        `\`calibration:\`.`,
    );
  }

  const fit: FittedTransform = fitTransform(pts, 'swap-similarity');
  const holdout: HoldoutReport = holdoutValidate(pts, 'swap-similarity');

  const segs = input.route
    ? segmentsFromRoute(input.route)
    : input.tour
      ? segmentsFromTour(input.tour)
      : [];

  const markers =
    opts.markers ??
    (input.route
      ? [input.route.target, ...(input.route.startBeacon ? [input.route.startBeacon] : [])]
      : input.tour
        ? input.tour.stops.map((s) => s.poi)
        : []);

  const project = (p: Poi) => fit.apply(p.world_x, p.world_y);

  const allPoints = [
    ...segs.flatMap((s) => [project(s.from), project(s.to)]),
    ...markers.map(project),
  ];
  if (allPoints.length === 0) {
    throw new Error('Nothing to render: no route legs or markers.');
  }

  const pad = opts.padding ?? 40;
  const minX = Math.min(...allPoints.map((p) => p.x)) - pad;
  const maxX = Math.max(...allPoints.map((p) => p.x)) + pad;
  const minY = Math.min(...allPoints.map((p) => p.y)) - pad;
  const maxY = Math.max(...allPoints.map((p) => p.y)) + pad;
  const w = Math.max(maxX - minX, 1);
  const h = Math.max(maxY - minY, 1);

  const parts: string[] = [];
  parts.push(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${minX.toFixed(2)} ${minY.toFixed(2)} ${w.toFixed(2)} ${h.toFixed(2)}" width="900" preserveAspectRatio="xMidYMid meet">`,
  );
  parts.push(
    `<desc>${esc(
      `palroute overlay. Coordinates are MAP units from a transform fitted to ` +
        `${pts.length} calibration point(s); max in-sample residual ` +
        `${fit.maxFitResidual.toFixed(3)} map units. ` +
        (holdout.performed
          ? `Leave-one-out max residual ${holdout.maxResidual.toFixed(3)}.`
          : `Hold-out validation NOT performed: ${holdout.reason}`),
    )}</desc>`,
  );
  parts.push(
    `<style>text{font-family:ui-sans-serif,system-ui,sans-serif;fill:#e6e6e6}` +
      `.lbl{font-size:${(h / 45).toFixed(2)}px}` +
      `.cap{font-size:${(h / 55).toFixed(2)}px;fill:#f0c674}</style>`,
  );

  // Segments.
  for (const s of segs) {
    const a = project(s.from);
    const b = project(s.to);
    const st = MODE_STYLE[s.mode] ?? MODE_STYLE['walk']!;
    const dash = st.dash ? ` stroke-dasharray="${st.dash}"` : '';
    const opacity = s.estimated ? 0.55 : 0.95;
    parts.push(
      `<line x1="${a.x.toFixed(2)}" y1="${a.y.toFixed(2)}" x2="${b.x.toFixed(2)}" y2="${b.y.toFixed(2)}" ` +
        `stroke="${st.stroke}" stroke-width="${(st.width * h) / 600}" stroke-opacity="${opacity}"${dash} ` +
        `stroke-linecap="round"><title>${esc(`${s.from.name} → ${s.to.name} (${s.mode}${s.estimated ? ', estimated' : ''})`)}</title></line>`,
    );
  }

  // Markers.
  const r = h / 130;
  markers.forEach((m, i) => {
    const p = project(m);
    const isBeacon = m.kind === 'fast_travel' || m.kind === 'palbox';
    const fill = isBeacon ? '#c96bd8' : '#f0c674';
    parts.push(
      `<circle cx="${p.x.toFixed(2)}" cy="${p.y.toFixed(2)}" r="${r.toFixed(2)}" fill="${fill}" ` +
        `stroke="#1c1c1c" stroke-width="${(r / 4).toFixed(2)}"><title>${esc(`${m.name} (${m.kind})`)}</title></circle>`,
    );
    parts.push(
      `<text class="lbl" x="${(p.x + r * 1.6).toFixed(2)}" y="${(p.y + r * 0.6).toFixed(2)}">${esc(
        `${i + 1}. ${m.name}`,
      )}</text>`,
    );
  });

  // Residual caption, drawn into the image.
  const caption = holdout.performed
    ? `transform: fitted from ${pts.length} points · leave-one-out max residual ${holdout.maxResidual.toFixed(2)} map units${holdout.pass ? '' : ' — EXCEEDS TOLERANCE'}`
    : `transform: fitted from ${pts.length} points · in-sample residual ${fit.maxFitResidual.toFixed(2)} map units · HOLD-OUT NOT PERFORMED (needs 3+ calibration points)`;
  parts.push(
    `<text class="cap" x="${(minX + pad / 3).toFixed(2)}" y="${(maxY - pad / 3).toFixed(2)}">${esc(caption)}</text>`,
  );

  parts.push('</svg>');

  return {
    svg: parts.join('\n'),
    transform: {
      model: fit.model,
      params: fit.similarity
        ? { scale: fit.similarity.scale, tx: fit.similarity.tx, ty: fit.similarity.ty }
        : {},
      max_fit_residual: fit.maxFitResidual,
      rms_fit_residual: fit.rmsFitResidual,
      holdout: {
        performed: holdout.performed,
        reason: holdout.reason,
        max_residual: holdout.performed ? holdout.maxResidual : null,
        pass: holdout.pass,
        points: holdout.results,
      },
    },
    bounds: { minX, minY, maxX, maxY },
  };
}
