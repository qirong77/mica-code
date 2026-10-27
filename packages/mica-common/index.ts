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
import { comparableContentText, comparableMessageText, comparableText, stripMediaPlaceholders } from './promptText.js';
import { splitAutolinkPunctuation } from './autolink.js';
import {
  MAX_SESSION_NOTES_LENGTH,
  SESSION_NOTES_PLUGIN_ID,
  SESSION_NOTES_TAG,
  appendSessionNotes,
  normalizeSessionNotes,
  sessionNotesSummary,
} from './sessionNotes.js';
import { BTW_STATE_VERSION, btwStatePath, deleteBtwState, readBtwState, writeBtwState } from './btwState.js';
import {
  CAPABILITY_SELECTION_VERSION,
  capabilityCounts,
  capabilitySelectionEquals,
  cloneCapabilitySelection,
  emptyCapabilitySelection,
  isCapabilityEnabled,
  isCapabilitySelectionEmpty,
  normalizeCapabilitySelection,
  setAllCapabilitiesEnabled,
  setCapabilityEnabled,
} from './capabilities.js';

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
  comparableContentText,
  comparableMessageText,
  comparableText,
  stripMediaPlaceholders,
  splitAutolinkPunctuation,
  MAX_SESSION_NOTES_LENGTH,
  SESSION_NOTES_TAG,
  SESSION_NOTES_PLUGIN_ID,
  appendSessionNotes,
  normalizeSessionNotes,
  sessionNotesSummary,
  BTW_STATE_VERSION,
  btwStatePath,
  deleteBtwState,
  readBtwState,
  writeBtwState,
  CAPABILITY_SELECTION_VERSION,
  capabilityCounts,
  capabilitySelectionEquals,
  cloneCapabilitySelection,
  emptyCapabilitySelection,
  isCapabilityEnabled,
  isCapabilitySelectionEmpty,
  normalizeCapabilitySelection,
  setAllCapabilitiesEnabled,
  setCapabilityEnabled,
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
export { comparableContentText, comparableMessageText, comparableText, stripMediaPlaceholders } from './promptText.js';
export { splitAutolinkPunctuation } from './autolink.js';
export type { AutolinkPunctuationSplit } from './autolink.js';
export {
  MAX_SESSION_NOTES_LENGTH,
  SESSION_NOTES_PLUGIN_ID,
  SESSION_NOTES_TAG,
  appendSessionNotes,
  normalizeSessionNotes,
  sessionNotesSummary,
} from './sessionNotes.js';
export { BTW_STATE_VERSION, btwStatePath, deleteBtwState, readBtwState, writeBtwState } from './btwState.js';
export type { StoredBtwThread } from './btwState.js';
export {
  MAX_TODOS,
  MAX_TODO_TEXT_LENGTH,
  RECOMMENDED_TODO_ITEMS,
  TODO_TOOL_NAME,
  appendTodoNotes,
  demoteExtraInProgress,
  formatTodoSummary,
  parseTodoInput,
  projectTodoSnapshot,
  resolveTodoDisplayItems,
  shouldShowTodoList,
  summarizeTodoProgress,
  todoItemLabel,
} from './todoState.js';
export type {
  TodoItem,
  TodoParseResult,
  TodoProgress,
  TodoSnapshot,
  TodoStatus,
  TodoWriteEntry,
} from './todoState.js';
export {
  CAPABILITY_SELECTION_VERSION,
  capabilityCounts,
  capabilitySelectionEquals,
  cloneCapabilitySelection,
  emptyCapabilitySelection,
  isCapabilityEnabled,
  isCapabilitySelectionEmpty,
  normalizeCapabilitySelection,
  setAllCapabilitiesEnabled,
  setCapabilityEnabled,
} from './capabilities.js';
export type { CapabilityKind, CapabilitySelection } from './capabilities.js';
export { LEGACY_TOOL_NAMES, normalizeToolName } from './toolNames.js';
