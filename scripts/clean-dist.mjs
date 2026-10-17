/**
 * Removes dist/ before `npm run build` compiles into it. tsc never deletes
 * output, so a module whose source was deleted or renamed kept its old
 * dist/ file, and "files": ["dist"] shipped it in the npm tarball. A full
 * rebuild costs nothing extra: the build is not incremental.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * @param {string} dir the directory to remove; a missing one is fine
 * @returns {Promise<void>}
 */
export async function cleanDist(dir) {
  await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await cleanDist(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist'));
}
