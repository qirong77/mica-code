import type { PtyManager } from '@packages/mica-pty/index.js';

/**
 * Lazily resolves the shared PtyManager. The manager module lives in mica-pty
 * and is only loaded on first PTY tool use, so an environment without
 * node-pty degrades to a tool-level error instead of breaking mica startup.
 */
let managerPromise: Promise<PtyManager> | null = null;

export function getPtyManager(): Promise<PtyManager> {
  managerPromise ??= import('@packages/mica-pty/index.js').then((m) => m.ptyManager);
  return managerPromise;
}
