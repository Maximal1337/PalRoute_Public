// Base map image and its calibration. No world -> image-pixel transform is
// published for this image, so the placement below was derived by searching
// scale, offset and axis flip against a land/water mask of the image.

export const DEFAULT_PLACEMENT = {
  //   pixelX = mapX * flipX * scale + offsetX
  //   pixelY = mapY * flipY * scale + offsetY
  scale: 0.3177,
  offsetX: 607.3,
  offsetY: 318.1,
  flipX: 1,
  flipY: -1,
};

// Fit metrics for the constants above, derived by correlating POI density
// against land density. Display -> Align base map adjusts them at runtime.
export const FIT_EVIDENCE = {
  method: 'POI-density / land-density correlation, 25x25 grid',
  correlation: 0.729,
  poisOnLand: 0.903,
  randomBaseline: 0.274,
  landmassCoverage: '18/18',
  visuallyConfirmed: true,
};

const STORAGE_KEY = 'palroute.basemap.placement';

function loadPlacement() {
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null');
    if (raw && Number.isFinite(raw.scale)) return { ...DEFAULT_PLACEMENT, ...raw };
  } catch { /* ignore corrupt state */ }
  return { ...DEFAULT_PLACEMENT };
}

export function savePlacement(p) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(p));
  } catch { /* private mode */ }
}

export function resetPlacement() {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch { /* ignore */ }
  Object.assign(BASE_MAP, DEFAULT_PLACEMENT);
  return BASE_MAP;
}

export const BASE_MAP = {
  // WebP; the extension must match or servers announce the wrong type.
  url: '/data/Palpagos_Islands_World_Map.webp',
  width: 1000,
  height: 1000,
  ...loadPlacement(),
  fit: FIT_EVIDENCE,
};

/**
 * Compose the backend's fitted world->map transform with the image placement.
 * Null when no transform was supplied.
 */
export function makeWorldToPixel(mapTransform, base = BASE_MAP) {
  const p = mapTransform?.params;
  if (!p || !Number.isFinite(p.scale) || p.scale === 0) return null;

  const { scale: s, tx, ty } = p;
  const { scale: k, offsetX, offsetY, flipX, flipY } = base;

  return {
    toPixel(worldX, worldY) {
      const mapX = (worldY + ty) / s;
      const mapY = (worldX + tx) / s;
      return { x: mapX * flipX * k + offsetX, y: mapY * flipY * k + offsetY };
    },
    toWorld(px, py) {
      const mapX = (px - offsetX) / (flipX * k);
      const mapY = (py - offsetY) / (flipY * k);
      return { x: mapY * s - tx, y: mapX * s - ty };
    },
    /** Image pixels per metre: one map unit is `s` cm and one pixel is 1/k map units. */
    pixelsPerMetre: (100 * k) / s,
  };
}

/** Load the base image. Resolves to null rather than throwing if it is absent. */
export function loadBaseMap(url = BASE_MAP.url) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = url;
  });
}
