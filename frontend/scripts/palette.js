// Canvas colours, read from the CSS custom properties and cached per name.

const cache = new Map();

function cssVar(name, fallback) {
  if (cache.has(name)) return cache.get(name);
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const out = v || fallback;
  cache.set(name, out);
  return out;
}

/** Clear the cache after a theme change. */
export function invalidatePalette() {
  cache.clear();
}

export const KIND_ORDER = [
  'fast_travel',
  'palbox',
  'alpha_boss',
  'field_boss',
  'predator',
  'effigy',
  'dungeon_entrance',
  'dungeon_boss',
  'tower_boss',
  'map_unlock',
  'merchant',
  'chest',
  'ore_node',
];

const KIND_FALLBACK = '#8b93a7';

export function kindColor(kind) {
  return cssVar(`--kind-${kind}`, KIND_FALLBACK);
}

export function modeColor(mode) {
  return cssVar(`--mode-${mode}`, cssVar('--mode-walk', '#6ea8fe'));
}

export const ui = {
  get fg() { return cssVar('--fg', '#e7eaf2'); },
  get fgMuted() { return cssVar('--fg-muted', '#9aa4bb'); },
  get fgFaint() { return cssVar('--fg-faint', '#6b7590'); },
  get line() { return cssVar('--line', '#2a3040'); },
  get lineSoft() { return cssVar('--line-soft', '#20252f'); },
  get surface1() { return cssVar('--surface-1', '#11141b'); },
  get surface2() { return cssVar('--surface-2', '#171b24'); },
  get accent() { return cssVar('--accent', '#6ea8fe'); },
  get warn() { return cssVar('--warn', '#fbbf24'); },
  get bg() { return cssVar('--bg', '#0b0d12'); },
};

/** Marker radius by kind. */
export function kindRadius(kind) {
  switch (kind) {
    case 'fast_travel':
    case 'palbox':
      return 5.5;
    case 'alpha_boss':
    case 'tower_boss':
      return 5;
    case 'field_boss':
    case 'predator':
      return 4;
    case 'dungeon_entrance':
    case 'dungeon_boss':
      return 3.5;
    default:
      return 3;
  }
}

/** Draw order: background kinds first, beacons last. */
export function kindZ(kind) {
  return KIND_ORDER.length - KIND_ORDER.indexOf(kind);
}
