// Shared presentation helpers for the desktop renderer and runtime. Pure
// functions only: no React, no runtime deps, so the electron-vite renderer and
// the runtime bundle can both consume it.

export { relativeTimeShort } from './time.js';
export { formatTokens } from './format.js';
export { toolIcon, toolLabel } from './tools.js';
