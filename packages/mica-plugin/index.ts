import { Plugin } from './Plugin.js';
import { PluginManager } from './PluginManager.js';
import { HookRegistry } from './HookRegistry.js';
import { ServiceContainer } from './ServiceContainer.js';
import { createServiceToken } from './ServiceToken.js';
import { loadFilePlugins } from './FilePluginLoader.js';

export const micaPlugin = {
  Plugin,
  PluginManager,
  HookRegistry,
  ServiceContainer,
  createServiceToken,
  loadFilePlugins,
};

export type { Plugin } from './Plugin.js';
export type { MicaPlugin } from './Plugin.js';
export type { PluginManager } from './PluginManager.js';
export type { PluginSetupReport } from './PluginManager.js';
export type { PluginContext } from './PluginContext.js';
export type { PluginStatusItem } from './PluginContext.js';
export type { HookRegistry } from './HookRegistry.js';
export type { GuardHookResult, HookExecutionContext, HookHandler, HookKind, HookOptions } from './HookTypes.js';
export type { ServiceContainer } from './ServiceContainer.js';
export type { ServiceToken } from './ServiceToken.js';
export type { FilePluginLoaderOptions, FilePluginLoadResult } from './FilePluginLoader.js';
