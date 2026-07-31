import { chmodSync, existsSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';

/**
 * node-pty ships prebuilt `spawn-helper` binaries without the executable bit
 * when installed through Bun (Bun skips the package's install scripts unless
 * `trustedDependencies` is honoured, which it currently is not). Without this
 * fix `spawn()` fails with "posix_spawnp failed" / EACCES.
 *
 * Idempotent; safe to call before every spawn.
 */
let ensured = false;

export function ensureSpawnHelperExecutable(): void {
  if (ensured) return;
  if (process.platform === 'win32') {
    ensured = true;
    return;
  }
  try {
    const require = createRequire(import.meta.url);
    const entry = require.resolve('node-pty');
    const pkgRoot = resolve(dirname(entry), '..');
    const helper = join(pkgRoot, 'prebuilds', `${process.platform}-${process.arch}`, 'spawn-helper');
    if (existsSync(helper) && (statSync(helper).mode & 0o111) === 0) {
      chmodSync(helper, 0o755);
    }
  } catch {
    // Swallow resolution errors: a real spawn error will surface the problem.
  }
  ensured = true;
}
