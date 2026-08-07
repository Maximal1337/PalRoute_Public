import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { LOCKFILE_PATH, VENDOR_DIR } from '../core/paths.js';
import { SOURCES, type SourceDefinition } from './sources.js';

// Upstream data is fetched at build time and never committed. Only a lockfile
// of URLs, SHA-256 hashes and row counts is kept in the repository.

export interface LockEntry {
  id: string;
  url: string;
  sha256: string;
  bytes: number;
  row_count: number;
  fetched_at: string;
  license: string;
  notes: string;
}

export interface Lockfile {
  /** Bumped when the adapter semantics change, not when data changes. */
  lock_version: number;
  entries: Record<string, LockEntry>;
}

const EMPTY_LOCK: Lockfile = { lock_version: 1, entries: {} };

export function sha256(buf: Buffer | string): string {
  return createHash('sha256').update(buf).digest('hex');
}

export async function readLockfile(): Promise<Lockfile> {
  try {
    const raw = await fs.readFile(LOCKFILE_PATH, 'utf8');
    return JSON.parse(raw) as Lockfile;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { ...EMPTY_LOCK };
    throw err;
  }
}

async function writeLockfile(lock: Lockfile): Promise<void> {
  await fs.mkdir(path.dirname(LOCKFILE_PATH), { recursive: true });
  await fs.writeFile(LOCKFILE_PATH, JSON.stringify(lock, null, 2) + '\n', 'utf8');
}

function vendorPath(id: string): string {
  return path.join(VENDOR_DIR, `${id}.json`);
}

/** Count records regardless of array vs keyed-map shape. */
function rowCount(parsed: unknown): number {
  if (Array.isArray(parsed)) return parsed.length;
  if (parsed && typeof parsed === 'object') return Object.keys(parsed).length;
  return 0;
}

export interface FetchReport {
  id: string;
  status: 'fetched' | 'unchanged' | 'failed' | 'mismatch';
  bytes: number;
  rows: number;
  sha256: string;
  /** The hash the lockfile expected. Only set when status is 'mismatch'. */
  expected?: string;
  error?: string;
}

/**
 * Download every source into data/vendor/. One failure does not abort the rest.
 *
 * Default mode rewrites the lockfile from what upstream serves. `frozen`
 * verifies against the committed lockfile and writes nothing that drifted.
 */
export async function fetchAllSources(
  opts: { only?: string[]; timeoutMs?: number; frozen?: boolean } = {},
): Promise<FetchReport[]> {
  const targets = opts.only?.length
    ? SOURCES.filter((s) => opts.only!.includes(s.id))
    : SOURCES;

  await fs.mkdir(VENDOR_DIR, { recursive: true });
  const lock = await readLockfile();
  const reports: FetchReport[] = [];

  for (const src of targets) {
    try {
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), opts.timeoutMs ?? 30_000);
      let res: Response;
      try {
        res = await fetch(src.url, { signal: ac.signal });
      } finally {
        clearTimeout(timer);
      }
      if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);

      const buf = Buffer.from(await res.arrayBuffer());
      const digest = sha256(buf);
      const parsed: unknown = JSON.parse(buf.toString('utf8'));
      const rows = rowCount(parsed);

      const prior = lock.entries[src.id];
      const unchanged = prior?.sha256 === digest;

      // Frozen: drift is reported and nothing is written to disk.
      if (opts.frozen) {
        if (!prior) {
          reports.push({
            id: src.id,
            status: 'mismatch',
            bytes: buf.byteLength,
            rows,
            sha256: digest,
            error: 'not present in the lockfile',
          });
          continue;
        }
        if (!unchanged) {
          reports.push({
            id: src.id,
            status: 'mismatch',
            bytes: buf.byteLength,
            rows,
            sha256: digest,
            expected: prior.sha256,
            error: `upstream changed (${prior.row_count} -> ${rows} rows)`,
          });
          continue;
        }
        await fs.writeFile(vendorPath(src.id), buf);
        reports.push({
          id: src.id,
          status: 'unchanged',
          bytes: buf.byteLength,
          rows,
          sha256: digest,
        });
        continue;
      }

      await fs.writeFile(vendorPath(src.id), buf);
      lock.entries[src.id] = {
        id: src.id,
        url: src.url,
        sha256: digest,
        bytes: buf.byteLength,
        row_count: rows,
        // Identical bytes keep the old timestamp.
        fetched_at: unchanged && prior ? prior.fetched_at : new Date().toISOString(),
        license: src.license,
        notes: src.notes,
      };

      reports.push({
        id: src.id,
        status: unchanged ? 'unchanged' : 'fetched',
        bytes: buf.byteLength,
        rows,
        sha256: digest,
      });
    } catch (err) {
      reports.push({
        id: src.id,
        status: 'failed',
        bytes: 0,
        rows: 0,
        sha256: '',
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Frozen mode never writes the lockfile.
  if (!opts.frozen) await writeLockfile(lock);
  return reports;
}

export class SourceIntegrityError extends Error {}

/**
 * Load a fetched source and verify it against the lockfile. A hash mismatch
 * throws.
 */
export async function loadSource(
  src: SourceDefinition,
  opts: { verify?: boolean } = {},
): Promise<unknown> {
  const p = vendorPath(src.id);
  let buf: Buffer;
  try {
    buf = await fs.readFile(p);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new SourceIntegrityError(
        `Source "${src.id}" not present at ${p}. Run: npm run data:fetch`,
      );
    }
    throw err;
  }

  if (opts.verify !== false) {
    const lock = await readLockfile();
    const entry = lock.entries[src.id];
    if (entry) {
      const digest = sha256(buf);
      if (digest !== entry.sha256) {
        throw new SourceIntegrityError(
          `Source "${src.id}" hash mismatch.\n` +
            `  lockfile: ${entry.sha256}\n` +
            `  on disk:  ${digest}\n` +
            `Re-run "npm run data:fetch" to refresh, and review the diff before ` +
            `committing the updated lockfile.`,
        );
      }
    }
  }

  return JSON.parse(buf.toString('utf8'));
}
