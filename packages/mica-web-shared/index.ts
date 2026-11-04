// Shared presentation helpers for the desktop renderer and runtime. Pure
// functions only: no React, no runtime deps, so the electron-vite renderer and
// the runtime bundle can both consume it.

export { formatElapsed, relativeTimeShort } from './time.js';
export {
  CONFIG_WEB_PORT_ENV,
  DEFAULT_CONFIG_WEB_PORT,
  DEFAULT_RUNTIME_PORT,
  DEFAULT_RUNTIME_URL,
  RUNTIME_LOOPBACK_HOST,
  RUNTIME_PORT_ENV,
  loopbackRuntimeUrl,
  parseRuntimePort,
} from './runtime-port.js';
export {
  isLoopbackRuntime,
  isSameRuntime,
  normalizeEntryAddress,
  normalizeRuntimeAddress,
  relayTokenOf,
  runtimeLabel,
} from './runtime-address.js';
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
export { DAY_MS, addDays, dayStartMs, localDayKey } from './stats-day.js';
export {
  countUsageRequests,
  MAIN_USAGE_SOURCE,
  USAGE_SOURCE_LABELS,
  usageSourceKey,
  usageSourceOf,
} from './usage-source.js';
export type { UsageSource, UsageSourceKind } from './usage-source.js';
export { parseUsageLedger } from './usage-ledger.js';
export type { UsageLedgerEntry } from './usage-ledger.js';
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
  resolveLegacyWorkspace,
} from './ui-state.js';
export {
  DEFAULT_DARK_THEME,
  DEFAULT_LIGHT_THEME,
  DEFAULT_THEME_PREFERENCE,
  THEMES,
  THEME_PREFERENCES,
  THEME_UI_STATE_KEY,
  isThemeId,
  isThemePreference,
  normalizeThemePreference,
  resolveThemeName,
  themeAppearance,
  themeCanvasColor,
  themeLabel,
} from './theme.js';
export type { ResolvedTheme, ThemeAppearance, ThemeDefinition, ThemeId, ThemePreference } from './theme.js';
