import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// This file lives at src/config (tsx) or dist/config (compiled): two levels below the backend root.
const here = dirname(fileURLToPath(import.meta.url));

export const BACKEND_ROOT = resolve(here, '..', '..');
export const REPO_ROOT = resolve(BACKEND_ROOT, '..');
export const SAMPLE_CSV = join(BACKEND_ROOT, 'data', 'patients.csv');
