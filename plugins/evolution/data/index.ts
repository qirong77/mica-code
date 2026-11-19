import { browserCookieSyncExtension } from './browser-cookie-sync.js';
import { configModelDiscovery } from './config.js';
import { floatingWindowFavorites } from './floatingwindow.js';
import { harnessReviewAssessments } from './harness-review.js';
import { memoryScopes } from './memory.js';
import { notebookComments } from './notebook-comments.js';
import { notebookMcpData } from './notebook-mcp.js';
import { pluginEventIdentity } from './plugin-events.js';
import { pluginHealthIssues, pluginStartupHealth } from './plugin-health.js';
import { pluginHealthRuntimeHistory } from './plugin-health-runtime.js';
import { promptContributions } from './prompt-contributions.js';
import { sessionTagSlots } from './session-tags.js';
import { sshAuditV2 } from './ssh-audit.js';
import { subagentTaskFiles } from './subagent-tasks.js';
import type { DataMigration } from './types.js';

export { runDataMigrations } from './types.js';
export type { DataMigration, DataMigrationContext, DataMigrationOutcome } from './types.js';

export const DATA_MIGRATIONS: DataMigration[] = [
  memoryScopes,
  sessionTagSlots,
  configModelDiscovery,
  floatingWindowFavorites,
  browserCookieSyncExtension,
  harnessReviewAssessments,
  pluginEventIdentity,
  pluginStartupHealth,
  pluginHealthIssues,
  pluginHealthRuntimeHistory,
  sshAuditV2,
  subagentTaskFiles,
  notebookComments,
  notebookMcpData,
  promptContributions,
];
