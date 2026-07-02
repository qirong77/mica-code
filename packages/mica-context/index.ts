import {
  COMPACT_BOUNDARY_PREFIX,
  COMPACT_SUMMARY_PREFIX,
  CompactionNotNeededError,
  CompactionPromptTooLongError,
  CompactionService,
  isCompactionNotNeededError,
} from './CompactionService.js';

export const micaContext = {
  COMPACT_BOUNDARY_PREFIX,
  COMPACT_SUMMARY_PREFIX,
  CompactionNotNeededError,
  CompactionPromptTooLongError,
  CompactionService,
  isCompactionNotNeededError,
};

export { CompactionNotNeededError, CompactionPromptTooLongError, isCompactionNotNeededError };
export type { CompactInput, CompactMode, CompactOptions, CompactResult, CompactStrategy } from './CompactionService.js';
