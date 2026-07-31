import type { PtyManager } from '@packages/mica-pty/index.js';

/**
 * Lazily resolves the shared PtyManager. The manager module lives in mica-pty
 * and is only loaded on first PTY tool use, so an environment without
 * node-pty degrades to a tool-level error instead of breaking mica startup.
 *
 * The manager is loaded from its own module path (not the mica-pty index) so
 * the Bun process never pulls in node-pty (driver.ts imports it, and Bun's
 * compiled binary cannot resolve node-pty at runtime).
 */
let managerPromise: Promise<PtyManager> | null = null;

export function getPtyManager(): Promise<PtyManager> {
  managerPromise ??= import('@packages/mica-pty/src/manager.js').then((m) => m.ptyManager);
  return managerPromise;
}
