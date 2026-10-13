import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

let tempCounter = 0;

/**
 * Writes JSON via a temp file + rename so readers (and a crash mid-write)
 * never observe a half-written file.
 */
export async function writeJsonAtomic(path: string, data: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const content = `${JSON.stringify(data, null, 2)}\n`;
  const tempPath = `${path}.${process.pid}.${(tempCounter += 1)}.tmp`;
  await writeFile(tempPath, content, 'utf8');
  try {
    await rename(tempPath, path);
  } catch (error) {
    // Windows can refuse to replace a file another process (e.g. an editor or
    // antivirus scanner) has open; fall back to a direct write.
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'EPERM' && code !== 'EACCES' && code !== 'EBUSY') throw error;
    await writeFile(path, content, 'utf8');
    await rm(tempPath, { force: true });
  }
}
