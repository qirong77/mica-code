import { Plugin } from './Plugin.js';
import { PluginManager } from './PluginManager.js';
import { HookRegistry } from './HookRegistry.js';
import { ServiceContainer } from './ServiceContainer.js';
import { createServiceToken } from './ServiceToken.js';
import { inspectPlugins, loadFilePlugins } from './FilePluginLoader.js';
import { parsePluginManifest, PLUGIN_API_VERSION, PLUGIN_MANIFEST_FILE } from './PluginManifest.js';
import {
  PLUGIN_STATE_FILE,
  readDisabledPluginIds,
  readPluginState,
  setPluginDisabled,
  writePluginState,
} from './PluginState.js';

export const micaPlugin = {
  Plugin,
  PluginManager,
  HookRegistry,
  ServiceContainer,
  createServiceToken,
  loadFilePlugins,
  inspectPlugins,
  parsePluginManifest,
  readPluginState,
  readDisabledPluginIds,
  writePluginState,
  setPluginDisabled,
  PLUGIN_MANIFEST_FILE,
  PLUGIN_API_VERSION,
  PLUGIN_STATE_FILE,
};

export type { Plugin } from './Plugin.js';
export type { MicaPlugin } from './Plugin.js';
export {
  PLUGIN_API_VERSION,
  PLUGIN_MANIFEST_FILE,
  PLUGIN_ENTRY_CANDIDATES,
  isSafePluginRelativePath,
  parsePluginManifest,
} from './PluginManifest.js';
export {
  PLUGIN_STATE_FILE,
  normalizePluginState,
  readDisabledPluginIds,
  readPluginState,
  resolvePluginStatePath,
  setPluginDisabled,
  writePluginState,
} from './PluginState.js';
export type { PluginManager } from './PluginManager.js';
export type { PluginSetupReport } from './PluginManager.js';
export type { PluginContext } from './PluginContext.js';
export type {
  PluginFileMentionItem,
  PluginFileMentionProvider,
  PluginStatusItem,
  PluginToolRegistrationOptions,
} from './PluginContext.js';
export type { HookRegistry } from './HookRegistry.js';
export type { GuardHookResult, HookExecutionContext, HookHandler, HookKind, HookOptions } from './HookTypes.js';
export type { ServiceContainer } from './ServiceContainer.js';
export type { ServiceToken } from './ServiceToken.js';
export type {
  FilePluginLoaderOptions,
  FilePluginLoadResult,
  LoadedFilePlugin,
  PluginInspection,
  PluginInspectionResult,
} from './FilePluginLoader.js';
export type { PluginManifest, PluginManifestParseResult } from './PluginManifest.js';
export type { PluginState, PluginStateOptions } from './PluginState.js';
