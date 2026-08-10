import { DisposableStore, toDisposable } from './disposable.js';
import { TypedEventBus } from './eventBus.js';
import { formatTokenCount } from './format.js';
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
  formatTokenCount,
};

export type { Disposable } from './disposable.js';
export type { JsonPrimitive, JsonValue } from './json.js';
export type { Result } from './result.js';
export { formatTokenCount } from './format.js';
export { formatExecError, gitBuffer, gitBufferAsync, gitText, gitTextAsync, safeGitText, safeGitTextAsync };
export type { GitCommandOptions } from './git.js';
export { prepareImageForApi } from './image.js';
export type { ProcessedImage, SupportedImageMediaType } from './image.js';
export { APP_DISPLAY_NAME, APP_NAME, APP_TITLE_NAME } from './appName.js';
