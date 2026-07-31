import { PtyDriver } from './src/driver.js';
import { stripAnsi, ANSI_STRIP_RE } from './src/ansi.js';
import { KEYS, ctrl, key } from './src/keys.js';
import { ensureSpawnHelperExecutable } from './src/ensureExecutable.js';
import { PtyManager, ptyManager } from './src/manager.js';
import { ptyServerSource } from './src/ptyServerSource.js';

export const micaPty = {
  PtyDriver,
  stripAnsi,
  ANSI_STRIP_RE,
  KEYS,
  ctrl,
  key,
  ensureSpawnHelperExecutable,
  PtyManager,
  ptyManager,
  ptyServerSource,
};

export { PtyDriver } from './src/driver.js';
export type { PtySpawnOptions, WaitForOptions, TurnWaitOptions } from './src/driver.js';
export { stripAnsi, ANSI_STRIP_RE } from './src/ansi.js';
export { KEYS, ctrl, key } from './src/keys.js';
export type { KeyName } from './src/keys.js';
export { ensureSpawnHelperExecutable } from './src/ensureExecutable.js';
export { PtyManager, ptyManager } from './src/manager.js';
export { ptyServerSource } from './src/ptyServerSource.js';
export type { PtySessionInfo, PtyReadOptions, PtyReadResult, PtyWaitOptions, PtyWaitResult } from './src/manager.js';
