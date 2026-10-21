// Shared presentation helpers for the desktop renderer and runtime. Pure
// functions only: no React, no runtime deps, so the electron-vite renderer and
// the runtime bundle can both consume it.

export { relativeTimeShort } from './time.js';
export {
  APP_BASE_PATH,
  SHARE_BASE_PATH,
  TERMINAL_CONTROL_PREFIX,
  TERMINAL_PAGE_PATH,
  isAppPath,
  isSharePath,
  isTerminalPagePath,
  isUnderBasePath,
  normalizePathname,
  terminalControlPath,
  toAssetPath,
} from './app-paths.js';
export { formatTokens } from './format.js';
export { toolIcon, toolLabel } from './tools.js';
export {
  DEFAULT_SESSION_SEARCH_RANGE,
  SEARCH_TIERS,
  SESSION_SEARCH_RANGES,
  extractSnippet,
  foldSearchText,
  matchAllTokens,
  matchRanges,
  scoreSessionSearch,
  sessionSearchRange,
  sessionSearchSinceMs,
  tokenizeSearchQuery,
} from './session-search.js';
export {
  applyUiStatePatch,
  isUiStateKey,
  sanitizeUiStateKeys,
  uiStateChangeSet,
  uiStateValuesEqual,
} from './ui-state.js';
