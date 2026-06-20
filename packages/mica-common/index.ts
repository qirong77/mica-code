import { DisposableStore, toDisposable } from './disposable.js';
import { TypedEventBus } from './eventBus.js';
import { createId } from './ids.js';
import { formatExecError, gitBuffer, gitText, safeGitText } from './git.js';

export const micaCommon = {
  DisposableStore,
  toDisposable,
  TypedEventBus,
  createId,
  gitBuffer,
  gitText,
  safeGitText,
  formatExecError,
};

export type { Disposable } from './disposable.js';
export type { JsonPrimitive, JsonValue } from './json.js';
export type { Result } from './result.js';
export { formatExecError, gitBuffer, gitText, safeGitText };
export type { GitCommandOptions } from './git.js';
