import { DisposableStore, toDisposable } from './disposable.js';
import { TypedEventBus } from './eventBus.js';
import { createId } from './ids.js';
import {
  formatExecError,
  gitBuffer,
  gitBufferAsync,
  gitText,
  gitTextAsync,
  safeGitText,
  safeGitTextAsync,
} from './git.js';

export const micaCommon = {
  DisposableStore,
  toDisposable,
  TypedEventBus,
  createId,
  gitBuffer,
  gitBufferAsync,
  gitText,
  gitTextAsync,
  safeGitText,
  safeGitTextAsync,
  formatExecError,
};

export type { Disposable } from './disposable.js';
export type { JsonPrimitive, JsonValue } from './json.js';
export type { Result } from './result.js';
export {
  formatExecError,
  gitBuffer,
  gitBufferAsync,
  gitText,
  gitTextAsync,
  safeGitText,
  safeGitTextAsync,
};
export type { GitCommandOptions } from './git.js';
