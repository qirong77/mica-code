import {
  COMPACT_BOUNDARY_PREFIX,
  COMPACT_SUMMARY_PREFIX,
  CompactionNotNeededError,
  CompactionPromptTooLongError,
  CompactionService,
  isCompactionNotNeededError,
} from './CompactionService.js';
import { estimateContextTokens, estimateTextTokens, resolveRequestOverhead } from './tokenEstimate.js';

export const micaContext = {
  COMPACT_BOUNDARY_PREFIX,
  COMPACT_SUMMARY_PREFIX,
  CompactionNotNeededError,
  CompactionPromptTooLongError,
  CompactionService,
  estimateContextTokens,
  estimateTextTokens,
  isCompactionNotNeededError,
  resolveRequestOverhead,
};

export { CompactionNotNeededError, CompactionPromptTooLongError, isCompactionNotNeededError };
export { estimateContextTokens, estimateTextTokens, resolveRequestOverhead } from './tokenEstimate.js';
export type { CompactInput, CompactMode, CompactOptions, CompactResult, CompactStrategy } from './CompactionService.js';
