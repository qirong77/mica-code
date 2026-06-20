import {
  COMPACT_SUMMARY_PREFIX,
  CompactionNotNeededError,
  CompactionService,
  isCompactionNotNeededError,
} from './CompactionService.js';

export const micaContext = {
  COMPACT_SUMMARY_PREFIX,
  CompactionNotNeededError,
  CompactionService,
  isCompactionNotNeededError,
};

export { CompactionNotNeededError, isCompactionNotNeededError };
export type { CompactInput, CompactResult } from './CompactionService.js';
