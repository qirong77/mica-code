import { browserCookieSyncExtension } from './browser-cookie-sync.js';
import { configModelDiscovery } from './config.js';
import { memoryScopes } from './memory.js';
import { sessionTagSlots } from './session-tags.js';
import type { DataMigration } from './types.js';

export { runDataMigrations } from './types.js';
export type { DataMigration, DataMigrationContext, DataMigrationOutcome } from './types.js';

export const DATA_MIGRATIONS: DataMigration[] = [
  memoryScopes,
  sessionTagSlots,
  configModelDiscovery,
  browserCookieSyncExtension,
];
