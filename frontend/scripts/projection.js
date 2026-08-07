import { makeWorldToPixel } from './basemap.js';

/**
 * World -> map space, which is the base image's pixel space. The chain is
 * world -> backend map coords (from /meta) -> image pixels (basemap.js).
 * Without a backend transform this reduces to an axis swap.
 */
export class Projection {
  constructor(transform = null) {
    this.setTransform(transform);
  }

  setTransform(transform) {
    this.mapper = makeWorldToPixel(transform);
    this.calibrated = this.mapper !== null;
    this.meta = transform ?? null;
  }

  /** Unreal world units -> map space (image pixels when calibrated). */
  worldToMap(wx, wy) {
    if (!this.mapper) return { x: wy, y: wx };
    return this.mapper.toPixel(wx, wy);
  }

  /** Map space -> Unreal world units. */
  mapToWorld(mx, my) {
    if (!this.mapper) return { x: my, y: mx };
    return this.mapper.toWorld(mx, my);
  }

  /** Map-space units per metre, for the grid and scale bar. */
  mapUnitsPerMetre() {
    return this.mapper ? this.mapper.pixelsPerMetre : 100;
  }
}

/** Bounding box of POIs in map space. */
export function boundsOf(pois, projection) {
  if (!pois.length) return { minX: -1, minY: -1, maxX: 1, maxY: 1 };
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of pois) {
    const { x, y } = projection.worldToMap(p.world.x, p.world.y);
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  return { minX, minY, maxX, maxY };
}
