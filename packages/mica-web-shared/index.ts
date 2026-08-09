// Shared presentation helpers for the web UIs (apps/sync/web and
// apps/desktop renderer). Pure functions only: no React, no runtime deps, so
// both build pipelines (Vite + TS and electron-vite renderer) can consume it.

export { formatTime, formatRelative, relativeTimeShort } from './time.js';
export { formatStatus, formatTokens, tokenCount, formatElapsedMs } from './format.js';
export { toolIcon, toolLabel } from './tools.js';
export { usageValues, modelLabel, contextUsage } from './context.js';
export type { UsageValues, ContextUsage, ContextTone } from './context.js';
