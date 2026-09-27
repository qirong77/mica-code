import { DisposableStore, toDisposable } from './disposable.js';
import { TypedEventBus } from './eventBus.js';
import { formatTokenCount } from './format.js';
import { createId } from './ids.js';
import {
  DEFAULT_LOOP_INTERVAL_MS,
  MAX_LOOP_INTERVAL_MS,
  MIN_LOOP_INTERVAL_MS,
  formatLoopInterval,
  parseLoopArgs,
  parseLoopDuration,
} from './loopArgs.js';
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
  DEFAULT_LOOP_INTERVAL_MS,
  MAX_LOOP_INTERVAL_MS,
  MIN_LOOP_INTERVAL_MS,
  formatLoopInterval,
  parseLoopArgs,
  parseLoopDuration,
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
export {
  DEFAULT_LOOP_INTERVAL_MS,
  LOOP_USAGE,
  MAX_LOOP_INTERVAL_MS,
  MIN_LOOP_INTERVAL_MS,
  formatLoopInterval,
  parseLoopArgs,
  parseLoopDuration,
} from './loopArgs.js';
export type { LoopArgsParseResult } from './loopArgs.js';
export { prepareImageForApi } from './image.js';
export type { ProcessedImage, SupportedImageMediaType } from './image.js';
