import {
  CONFIG_PATH,
  EFFORT_OPTIONS,
  readConfig,
  getConfig,
  updateConfig,
  loadProviderModels,
  loadMissingProviderModels,
} from './config.js';

export const micaConfig = {
  path: CONFIG_PATH,
  effortOptions: EFFORT_OPTIONS,
  read: readConfig,
  get: getConfig,
  update: updateConfig,
  loadProviderModels,
  loadMissingProviderModels,
};

export type { EffortOption, IMicaConfig, ProviderDefinition } from './config.js';
