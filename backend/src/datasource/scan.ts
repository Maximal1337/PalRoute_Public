// Field-signature discovery. Records are located by coordinate field signature
// rather than by table name, which handles both community JSON and
// FModel/repak exports.

export interface CoordKeyMap {
  /** Key holding X, relative to `container` (or the record root when null). */
  x: string;
  y: string;
  /** null when the source has no Z at all. */
  z: string | null;
  /** Nested object holding the coords, e.g. "Location". null = record root. */
  container: string | null;
}

export interface ScannedRecord {
  /** Object key when the group was a keyed map, else the array index. */
  key: string;
  value: Record<string, unknown>;
}

export interface RecordGroup {
  /** Where in the tree this was found, e.g. `$.Rows` or `$[0].Rows`. */
  path: string;
  /** Container shape, useful for diagnostics. */
  shape: 'array' | 'keyed-map';
  records: ScannedRecord[];
  coords: CoordKeyMap;
  /** Sorted union of non-coordinate keys — the "field signature". */
  fieldSignature: string[];
  /** Fraction of records that actually carried a finite Z. */
  zCoverage: number;
}

export interface ScanResult {
  groups: RecordGroup[];
  diagnostics: string[];
}

/** Coordinate key triples to probe, highest priority first. Matched case-insensitively. */
const COORD_TRIPLES: ReadonlyArray<readonly [string, string, string]> = [
  ['x', 'y', 'z'],
  ['locationx', 'locationy', 'locationz'],
  ['location_x', 'location_y', 'location_z'],
  ['worldx', 'worldy', 'worldz'],
  ['world_x', 'world_y', 'world_z'],
  ['posx', 'posy', 'posz'],
  ['pos_x', 'pos_y', 'pos_z'],
  ['positionx', 'positiony', 'positionz'],
  ['translationx', 'translationy', 'translationz'],
];

/** Nested containers that commonly hold a coordinate triple. */
const COORD_CONTAINERS = [
  'location',
  'worldlocation',
  'translation',
  'position',
  'pos',
  'coord',
  'coordinates',
  'relativelocation',
];

/** A group must have at least this many records to be considered a table. */
const MIN_GROUP_SIZE = 4;

/** At least this fraction of a group's records must expose the coord triple. */
const MIN_COORD_HIT_RATE = 0.8;

/** Records sampled when probing for a coordinate signature. */
const SAMPLE_SIZE = 24;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function lowerKeyIndex(rec: Record<string, unknown>): Map<string, string> {
  const m = new Map<string, string>();
  for (const k of Object.keys(rec)) m.set(k.toLowerCase(), k);
  return m;
}

function numeric(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  // FModel sometimes emits numbers as strings.
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

/** Probe a sample of records for a coordinate signature, with its hit rate. */
function detectCoords(
  sample: Record<string, unknown>[],
): { coords: CoordKeyMap; hitRate: number } | null {
  if (sample.length === 0) return null;

  const probe = (
    container: string | null,
  ): { coords: CoordKeyMap; hitRate: number } | null => {
    // Resolve the sub-object each record's coords live in.
    const bodies: Record<string, unknown>[] = [];
    for (const rec of sample) {
      if (container === null) {
        bodies.push(rec);
      } else {
        const actual = lowerKeyIndex(rec).get(container);
        const sub = actual === undefined ? undefined : rec[actual];
        if (isPlainObject(sub)) bodies.push(sub);
      }
    }
    if (bodies.length === 0) return null;

    let best: { coords: CoordKeyMap; hitRate: number } | null = null;

    for (const [lx, ly, lz] of COORD_TRIPLES) {
      let hits = 0;
      let xKey: string | undefined;
      let yKey: string | undefined;
      let zKey: string | undefined;

      for (const body of bodies) {
        const idx = lowerKeyIndex(body);
        const ax = idx.get(lx);
        const ay = idx.get(ly);
        if (ax === undefined || ay === undefined) continue;
        if (numeric(body[ax]) === null || numeric(body[ay]) === null) continue;
        hits++;
        xKey ??= ax;
        yKey ??= ay;
        const az = idx.get(lz);
        if (az !== undefined && numeric(body[az]) !== null) zKey ??= az;
      }

      const hitRate = hits / sample.length;
      if (xKey && yKey && hitRate >= MIN_COORD_HIT_RATE) {
        const candidate = {
          coords: { x: xKey, y: yKey, z: zKey ?? null, container },
          hitRate,
        };
        // Prefer the triple that also resolved a Z.
        if (!best || (candidate.coords.z && !best.coords.z)) best = candidate;
      }
    }
    return best;
  };

  // Root first, then nested containers.
  const rootHit = probe(null);
  if (rootHit) return rootHit;
  for (const c of COORD_CONTAINERS) {
    const hit = probe(c);
    if (hit) return hit;
  }
  return null;
}

function buildFieldSignature(
  records: ScannedRecord[],
  coords: CoordKeyMap,
): string[] {
  const keys = new Set<string>();
  const coordKeys = new Set(
    [coords.container ?? '', coords.container ? '' : coords.x, coords.container ? '' : coords.y, coords.container || !coords.z ? '' : coords.z].filter(Boolean),
  );
  for (const r of records.slice(0, 200)) {
    for (const k of Object.keys(r.value)) {
      if (!coordKeys.has(k)) keys.add(k);
    }
  }
  return [...keys].sort();
}

function makeGroup(
  path: string,
  shape: 'array' | 'keyed-map',
  records: ScannedRecord[],
  coords: CoordKeyMap,
): RecordGroup {
  let withZ = 0;
  for (const r of records) {
    const body =
      coords.container === null
        ? r.value
        : (r.value[
            lowerKeyIndex(r.value).get(coords.container) ?? ''
          ] as Record<string, unknown> | undefined);
    if (body && coords.z && numeric(body[coords.z]) !== null) withZ++;
  }
  return {
    path,
    shape,
    records,
    coords,
    fieldSignature: buildFieldSignature(records, coords),
    zCoverage: records.length === 0 ? 0 : withZ / records.length,
  };
}

/**
 * Walk a JSON tree and return every record group carrying a coordinate
 * signature. Never throws; unmatched shapes are reported in `diagnostics`.
 */
export function scanJson(root: unknown, rootLabel = '$'): ScanResult {
  const groups: RecordGroup[] = [];
  const diagnostics: string[] = [];
  const seen = new WeakSet<object>();

  const visit = (node: unknown, path: string, depth: number): void => {
    if (depth > 12 || node === null || typeof node !== 'object') return;
    if (seen.has(node)) return;
    seen.add(node);

    if (Array.isArray(node)) {
      const objs = node.filter(isPlainObject);
      if (objs.length >= MIN_GROUP_SIZE) {
        const hit = detectCoords(objs.slice(0, SAMPLE_SIZE));
        if (hit) {
          const records: ScannedRecord[] = [];
          node.forEach((v, i) => {
            if (isPlainObject(v)) records.push({ key: String(i), value: v });
          });
          groups.push(makeGroup(path, 'array', records, hit.coords));
          return; // don't descend into a matched table
        }
      }
      node.forEach((v, i) => visit(v, `${path}[${i}]`, depth + 1));
      return;
    }

    // Keyed map of records: { "<guid>": {...}, ... }
    const values = Object.values(node as Record<string, unknown>);
    const objValues = values.filter(isPlainObject);
    if (
      objValues.length >= MIN_GROUP_SIZE &&
      objValues.length / Math.max(values.length, 1) >= 0.8
    ) {
      const hit = detectCoords(objValues.slice(0, SAMPLE_SIZE));
      if (hit) {
        const records: ScannedRecord[] = [];
        for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
          if (isPlainObject(v)) records.push({ key: k, value: v });
        }
        groups.push(makeGroup(path, 'keyed-map', records, hit.coords));
        return;
      }
    }

    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      visit(v, `${path}.${k}`, depth + 1);
    }
  };

  visit(root, rootLabel, 0);

  if (groups.length === 0) {
    diagnostics.push(
      `No coordinate-bearing record group found under ${rootLabel}. ` +
        `Probed triples: ${COORD_TRIPLES.map((t) => t.join('/')).join(', ')} ` +
        `at record root and inside containers: ${COORD_CONTAINERS.join(', ')}. ` +
        `Top-level shape was ${describeShape(root)}. ` +
        `If a patch renamed the fields, add the new triple to COORD_TRIPLES in scan.ts.`,
    );
  }

  return { groups, diagnostics };
}

export function describeShape(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return `array(len=${v.length})`;
  if (typeof v === 'object') {
    const keys = Object.keys(v as object);
    return `object(keys=${keys.length}${keys.length ? `, first=${keys.slice(0, 3).join(',')}` : ''})`;
  }
  return typeof v;
}

/** Read a coordinate triple out of a scanned record. Z is null when absent. */
export function readCoords(
  rec: ScannedRecord,
  coords: CoordKeyMap,
): { x: number; y: number; z: number | null } | null {
  let body: Record<string, unknown> = rec.value;
  if (coords.container !== null) {
    const actual = lowerKeyIndex(rec.value).get(coords.container);
    const sub = actual === undefined ? undefined : rec.value[actual];
    if (!isPlainObject(sub)) return null;
    body = sub;
  }
  const x = numeric(body[coords.x]);
  const y = numeric(body[coords.y]);
  if (x === null || y === null) return null;
  const z = coords.z ? numeric(body[coords.z]) : null;
  return { x, y, z };
}

/** Pick the group with the most records. */
export function largestGroup(result: ScanResult): RecordGroup | null {
  if (result.groups.length === 0) return null;
  return result.groups.reduce((a, b) =>
    b.records.length > a.records.length ? b : a,
  );
}
