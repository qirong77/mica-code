import { accessSync, constants, existsSync, mkdirSync, statSync } from 'node:fs';
import { Box, Text } from '@anthropic/ink';
import { gitText as defaultGitText, type GitCommandOptions } from '@packages/mica-common/index.js';
import { micaConfig, type IMicaConfig, type ProviderDefinition } from '@packages/mica-config/index.js';
import { micaMcp, type McpServerConfig, type McpServerStatus } from '@packages/mica-mcp/index.js';
import { micaSession } from '@packages/mica-session/index.js';
import { micaTools } from '@packages/mica-tools/index.js';
import { micaUi } from '@packages/mica-ui/index.js';
import type { CommandAgent } from './services.js';

const PANEL_ID = 'doctor-panel';
const NODE_MAJOR_MIN = 22;

export type DoctorCheckStatus = 'ok' | 'warn' | 'error' | 'info';

export type DoctorCheck = {
  id: string;
  label: string;
  status: DoctorCheckStatus;
  detail: string;
  suggestion?: string;
};

export type DoctorSummary = Record<DoctorCheckStatus, number>;

export type DoctorReport = {
  generatedAt: string;
  cwd: string;
  summary: DoctorSummary;
  checks: DoctorCheck[];
};

export type DoctorReportOptions = {
  config?: IMicaConfig;
  configPath?: string;
  cwd?: string;
  env?: Record<string, string | undefined>;
  gitText?: (args: string[], options?: GitCommandOptions) => string;
  mcpConfig?: Record<string, McpServerConfig>;
  mcpStatuses?: McpServerStatus[];
  now?: Date;
  sessionDir?: string;
  storagePath?: string;
  toolCounts?: { builtin: number; mcp: number; total: number };
  versions?: Record<string, string | undefined>;
};

export function createDoctorCommand(agent: CommandAgent) {
  return {
    name: 'doctor',
    description: '诊断环境、配置、MCP、工具和会话状态',
    action: async () => {
      const report = await buildDoctorReport(agent);
      showDoctorPanel(report);
    },
  } satisfies Parameters<typeof micaUi.dropdown.setQuickCommands>[0][number];
}

export async function buildDoctorReport(
  agent?: CommandAgent,
  options: DoctorReportOptions = {},
): Promise<DoctorReport> {
  const config = options.config ?? micaConfig.get();
  const configPath = options.configPath ?? micaConfig.path;
  const cwd = options.cwd ?? process.cwd();
  const env = options.env ?? process.env;
  const versions = options.versions ?? (process.versions as Record<string, string | undefined>);
  const provider = findCurrentProvider(config);
  const mcpConfig = options.mcpConfig ?? (await micaMcp.loadConfig());
  const mcpStatuses = options.mcpStatuses ?? micaMcp.servers.get();
  const toolCounts = options.toolCounts ?? micaTools.getCounts();

  const checks = [
    checkRuntime(versions),
    checkWorkspace(cwd),
    checkReadableWritableFile('config-file', 'Config file', configPath),
    checkProvider(config, provider),
    checkProviderApiKey(provider, configPath),
    checkWebSearch(config, env, configPath),
    checkMcp(mcpConfig, mcpStatuses),
    checkTools(toolCounts),
    checkSessionDirectory(options.sessionDir ?? micaSession.dir),
    checkReadableWritableFile('storage-file', 'Storage file', options.storagePath ?? micaConfig.storage.path, true),
    checkGit(cwd, options.gitText ?? defaultGitText),
    ...(agent ? [checkAgentState(agent)] : []),
  ];

  return {
    generatedAt: (options.now ?? new Date()).toISOString(),
    cwd,
    summary: summarizeChecks(checks),
    checks,
  };
}

function showDoctorPanel(report: DoctorReport) {
  const initialText = micaUi.terminalInput.text.get();

  function hide() {
    micaUi.panels.removePluginUI(PANEL_ID);
  }

  function DoctorPanel() {
    return (
      <micaUi.Dialog
        title={`doctor (${formatSummary(report.summary)})`}
        footer={<micaUi.KeyHints hints={['esc exit', 'type to close']} />}
      >
        <micaUi.BottomScrollBox>
          <Text color={micaUi.theme.colors.dim}>{`${formatGeneratedAt(report.generatedAt)}  ${report.cwd}`}</Text>
          <Text> </Text>
          {report.checks.map((check) => (
            <Box key={check.id} flexDirection="column" paddingBottom={check.suggestion ? 1 : 0} minWidth={0}>
              <micaUi.OneLineItem
                cells={[
                  {
                    key: 'status',
                    content: statusLabel(check.status),
                    width: 6,
                    color: statusColor(check.status),
                    bold: check.status === 'error' || check.status === 'warn',
                  },
                  {
                    key: 'label',
                    content: check.label,
                    width: 18,
                    flexShrink: 0,
                  },
                  {
                    key: 'detail',
                    content: check.detail,
                    flexGrow: 1,
                    minWidth: 0,
                    color: check.status === 'error' ? micaUi.theme.colors.error : undefined,
                    dimColor: check.status === 'info',
                  },
                ]}
              />
              {check.suggestion ? (
                <Box paddingLeft={26} minWidth={0}>
                  <Text color={micaUi.theme.colors.dim} wrap="wrap">{`fix: ${check.suggestion}`}</Text>
                </Box>
              ) : null}
            </Box>
          ))}
        </micaUi.BottomScrollBox>
      </micaUi.Dialog>
    );
  }

  micaUi.panels.upsertPluginUI({
    id: PANEL_ID,
    component: DoctorPanel,
    preserveInput: true,
    onInput: (_input, key) => {
      if (!key.escape) return false;
      hide();
      return true;
    },
    onTextChange: (value) => {
      if (value !== initialText) hide();
      return false;
    },
  });
}

function checkRuntime(versions: Record<string, string | undefined>): DoctorCheck {
  const node = versions.node;
  const bun = versions.bun;
  const nodeMajor = parseMajorVersion(node);
  if (nodeMajor === null || nodeMajor < NODE_MAJOR_MIN) {
    return makeCheck(
      'runtime',
      'Runtime',
      'error',
      `Node ${node ?? 'unknown'}; Bun ${bun ?? 'missing'}`,
      `Use Node.js >=${NODE_MAJOR_MIN} and run Mica through Bun.`,
    );
  }
  if (!bun) {
    return makeCheck(
      'runtime',
      'Runtime',
      'warn',
      `Node ${node}; Bun missing`,
      'Install Bun or use a Bun-built binary.',
    );
  }
  return makeCheck('runtime', 'Runtime', 'ok', `Node ${node}; Bun ${bun}`);
}

function checkWorkspace(cwd: string): DoctorCheck {
  try {
    const stat = statSync(cwd);
    if (!stat.isDirectory()) {
      return makeCheck('workspace', 'Workspace', 'error', `${cwd} is not a directory`);
    }
    accessSync(cwd, constants.R_OK | constants.W_OK);
    return makeCheck('workspace', 'Workspace', 'ok', cwd);
  } catch (error) {
    return makeCheck('workspace', 'Workspace', 'error', formatError(error), `Check read/write permissions for ${cwd}.`);
  }
}

function checkReadableWritableFile(id: string, label: string, path: string, optional = false): DoctorCheck {
  try {
    if (!existsSync(path)) {
      return makeCheck(id, label, optional ? 'info' : 'warn', `${path} does not exist`);
    }
    accessSync(path, constants.R_OK | constants.W_OK);
    return makeCheck(id, label, 'ok', path);
  } catch (error) {
    return makeCheck(id, label, 'error', formatError(error), `Check read/write permissions for ${path}.`);
  }
}

function checkProvider(config: IMicaConfig, provider: ProviderDefinition | undefined): DoctorCheck {
  if (!provider) {
    return makeCheck(
      'provider',
      'Provider',
      'error',
      `current provider "${config.provider || '(empty)'}" was not found`,
    );
  }
  const modelCount = provider.models?.length ?? 0;
  const modelDetail =
    modelCount > 0 ? `${modelCount} model(s)` : provider.get_model_url ? 'dynamic models' : 'no model list';
  return makeCheck(
    'provider',
    'Provider',
    'ok',
    `${provider.name ?? provider.id} (${provider.id}); ${provider.protocol}; ${modelDetail}`,
  );
}

function checkProviderApiKey(provider: ProviderDefinition | undefined, configPath: string): DoctorCheck {
  if (!provider) return makeCheck('provider-api-key', 'API key', 'error', 'current provider is missing');
  if (provider.api_key?.trim()) return makeCheck('provider-api-key', 'API key', 'ok', `configured for ${provider.id}`);
  return makeCheck(
    'provider-api-key',
    'API key',
    'warn',
    `missing for ${provider.id}`,
    `Set providers[].api_key for "${provider.id}" in ${configPath}.`,
  );
}

function checkWebSearch(config: IMicaConfig, env: Record<string, string | undefined>, configPath: string): DoctorCheck {
  if (config.serperApiKey?.trim()) return makeCheck('web-search', 'Web search', 'ok', 'serperApiKey configured');
  if (env.SERPER_API_KEY?.trim()) return makeCheck('web-search', 'Web search', 'ok', 'SERPER_API_KEY configured');
  return makeCheck(
    'web-search',
    'Web search',
    'warn',
    'web_search unavailable',
    `Set serperApiKey in ${configPath} or export SERPER_API_KEY.`,
  );
}

function checkMcp(configs: Record<string, McpServerConfig>, statuses: McpServerStatus[]): DoctorCheck {
  const configured = Object.keys(configs);
  if (configured.length === 0) return makeCheck('mcp', 'MCP', 'info', 'no servers configured');

  const failed = statuses.filter((server) => server.status === 'failed');
  const connecting = statuses.filter((server) => server.status === 'connecting');
  const connected = statuses.filter((server) => server.status === 'connected');
  const missingStatuses = configured.filter((name) => !statuses.some((server) => server.name === name));

  if (failed.length > 0) {
    const names = failed.map((server) => server.name).join(', ');
    return makeCheck(
      'mcp',
      'MCP',
      'warn',
      `${connected.length}/${configured.length} connected; failed: ${names}`,
      `Run /mcp reconnect <server> for failed servers.`,
    );
  }
  if (connecting.length > 0 || missingStatuses.length > 0) {
    return makeCheck(
      'mcp',
      'MCP',
      'warn',
      `${connected.length}/${configured.length} connected; still initializing`,
      'Open /mcp for server details.',
    );
  }
  return makeCheck('mcp', 'MCP', 'ok', `${connected.length}/${configured.length} connected`);
}

function checkTools(counts: { builtin: number; mcp: number; total: number }): DoctorCheck {
  if (counts.builtin <= 0) {
    return makeCheck('tools', 'Tools', 'error', 'no built-in tools registered');
  }
  return makeCheck('tools', 'Tools', 'ok', `${counts.total} total (${counts.builtin} built-in, ${counts.mcp} MCP)`);
}

function checkSessionDirectory(sessionDir: string): DoctorCheck {
  try {
    mkdirSync(sessionDir, { recursive: true });
    const stat = statSync(sessionDir);
    if (!stat.isDirectory()) return makeCheck('sessions', 'Sessions', 'error', `${sessionDir} is not a directory`);
    accessSync(sessionDir, constants.R_OK | constants.W_OK);
    return makeCheck('sessions', 'Sessions', 'ok', sessionDir);
  } catch (error) {
    return makeCheck('sessions', 'Sessions', 'error', formatError(error), `Check permissions for ${sessionDir}.`);
  }
}

function checkGit(cwd: string, gitText: (args: string[], options?: GitCommandOptions) => string): DoctorCheck {
  try {
    const inside = gitText(['rev-parse', '--is-inside-work-tree'], { cwd, timeout: 5000 }).trim() === 'true';
    if (!inside) return makeCheck('git', 'Git', 'info', 'not a git worktree');
    const branch = gitText(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd, timeout: 5000 }).trim() || 'unknown';
    const status = gitText(['status', '--porcelain'], { cwd, timeout: 5000 });
    const changed = status.split('\n').filter(Boolean).length;
    if (changed > 0) return makeCheck('git', 'Git', 'info', `${branch}; ${changed} changed file(s)`);
    return makeCheck('git', 'Git', 'ok', `${branch}; clean`);
  } catch {
    return makeCheck('git', 'Git', 'info', 'not a git worktree');
  }
}

function checkAgentState(agent: CommandAgent): DoctorCheck {
  try {
    const snapshot = agent.getSnapshot();
    const state = agent.isRunning ? 'running' : 'idle';
    return makeCheck(
      'agent-state',
      'Agent state',
      agent.isRunning ? 'info' : 'ok',
      `${state}; ${snapshot.messages.length} message(s), ${snapshot.usageHistory.length} usage record(s)`,
    );
  } catch (error) {
    return makeCheck('agent-state', 'Agent state', 'warn', formatError(error));
  }
}

function findCurrentProvider(config: IMicaConfig): ProviderDefinition | undefined {
  return config.providers.find((provider) => provider.id === config.provider);
}

function summarizeChecks(checks: DoctorCheck[]): DoctorSummary {
  return checks.reduce<DoctorSummary>((summary, check) => ({ ...summary, [check.status]: summary[check.status] + 1 }), {
    ok: 0,
    warn: 0,
    error: 0,
    info: 0,
  });
}

function makeCheck(
  id: string,
  label: string,
  status: DoctorCheckStatus,
  detail: string,
  suggestion?: string,
): DoctorCheck {
  return {
    id,
    label,
    status,
    detail,
    ...(suggestion ? { suggestion } : {}),
  };
}

function statusLabel(status: DoctorCheckStatus): string {
  if (status === 'ok') return 'OK';
  if (status === 'warn') return 'WARN';
  if (status === 'error') return 'FAIL';
  return 'INFO';
}

function statusColor(status: DoctorCheckStatus): string | undefined {
  if (status === 'ok') return micaUi.theme.colors.success;
  if (status === 'warn') return micaUi.theme.colors.warning;
  if (status === 'error') return micaUi.theme.colors.error;
  return micaUi.theme.colors.dim;
}

function formatSummary(summary: DoctorSummary): string {
  return `OK ${summary.ok} / WARN ${summary.warn} / FAIL ${summary.error}`;
}

function formatGeneratedAt(value: string): string {
  try {
    return new Date(value).toLocaleString('zh-CN', { hour12: false });
  } catch {
    return value;
  }
}

function parseMajorVersion(version: string | undefined): number | null {
  const match = /^(\d+)/.exec(version ?? '');
  if (!match) return null;
  return Number.parseInt(match[1]!, 10);
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
