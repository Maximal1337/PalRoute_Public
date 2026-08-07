import { fileURLToPath } from 'node:url';
import path from 'node:path';

// Resolved relative to this file, so paths hold from any working directory.
const here = path.dirname(fileURLToPath(import.meta.url));
export const PROJECT_ROOT = path.resolve(here, '..', '..');

export const DATA_DIR = path.join(PROJECT_ROOT, 'data');
export const VENDOR_DIR = path.join(DATA_DIR, 'vendor');
export const CACHE_DIR = path.join(PROJECT_ROOT, '.cache');

export const POIS_PATH = path.join(DATA_DIR, 'pois.json');
export const LOCKFILE_PATH = path.join(DATA_DIR, 'sources.lock.json');
export const PROFILES_PATH = path.join(DATA_DIR, 'profiles.yaml');
export const EXPECTATIONS_PATH = path.join(DATA_DIR, 'expectations.yaml');
