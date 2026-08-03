import { micaTools, type MicaTool } from '@packages/mica-tools/index.js';
import {
  connectToServer,
  connections,
  disconnectAll,
  markServerConnected,
  markServerFailed,
  type ConnectedMcpServer,
} from './client.js';
import { loadMcpConfig, MCP_CONFIG_PATH, readMcpConfig, type McpServerConfig } from './config.js';
import { fetchToolsForServer } from './tools.js';

function configLabel(config: McpServerConfig): string {
  return 'url' in config ? config.url : `${config.command} ${(config.args ?? []).join(' ')}`.trim();
}

function extractToolInfo(tools: MicaTool[], serverName: string) {
  const prefix = `mcp__${serverName}__`;
  return tools.map((tool) => ({
    name: tool.name.startsWith(prefix) ? tool.name.slice(prefix.length) : tool.name,
    description: tool.description,
    inputSchema: tool.input_schema as Record<string, unknown>,
  }));
}

export type InitMcpOptions = {
  configPath?: string;
  strict?: boolean;
  signal?: AbortSignal;
  /** Maximum time for one server to finish connect + tools/list. */
  initTimeoutMs?: number;
  /** Initialize independent servers concurrently while preserving tool order. */
  parallel?: boolean;
};

type McpInitScope = {
  signal?: AbortSignal;
  dispose(): void;
  timedOut(): boolean;
};

export type McpInitDependencies = {
  connect: typeof connectToServer;
  fetchTools: typeof fetchToolsForServer;
  markConnected: typeof markServerConnected;
  markFailed: typeof markServerFailed;
  registerTools(tools: MicaTool[]): void;
  cleanup(server: ConnectedMcpServer): void;
};

const defaultInitDependencies: McpInitDependencies = {
  connect: connectToServer,
  fetchTools: fetchToolsForServer,
  markConnected: markServerConnected,
  markFailed: markServerFailed,
  registerTools: (tools) => micaTools.registerMcp(tools),
  cleanup: cleanupConnection,
};

export async function initMcp(options: InitMcpOptions = {}): Promise<void> {
  throwIfAborted(options.signal);
  const localConfigs = options.strict ? {} : await loadMcpConfig();
  const externalConfigs = options.configPath
    ? options.configPath === MCP_CONFIG_PATH
      ? await loadMcpConfig()
      : await readMcpConfig(options.configPath)
    : {};
  const configs = { ...localConfigs, ...externalConfigs };
  const entries = Object.entries(configs);
  if (entries.length === 0) {
    micaTools.unregisterMcp();
    return;
  }

  await initializeMcpEntries(entries, options);
}

export async function initializeMcpEntries(
  entries: [string, McpServerConfig][],
  options: InitMcpOptions,
  dependencies: McpInitDependencies = defaultInitDependencies,
): Promise<void> {
  const initialize = ([name, config]: [string, McpServerConfig]) =>
    initializeMcpServer(name, config, options, dependencies);
  const toolGroups = options.parallel
    ? await Promise.all(entries.map(initialize))
    : await initializeMcpServersSerially(entries, initialize);

  dependencies.registerTools(toolGroups.flat());
}

async function initializeMcpServersSerially(
  entries: [string, McpServerConfig][],
  initialize: (entry: [string, McpServerConfig]) => Promise<MicaTool[]>,
): Promise<MicaTool[][]> {
  const toolGroups: MicaTool[][] = [];
  for (const entry of entries) toolGroups.push(await initialize(entry));
  return toolGroups;
}

async function initializeMcpServer(
  name: string,
  config: McpServerConfig,
  options: InitMcpOptions,
  dependencies: McpInitDependencies,
): Promise<MicaTool[]> {
  throwIfAborted(options.signal);
  const scope = createMcpInitScope(options.signal, options.initTimeoutMs, name);
  let server: ConnectedMcpServer | undefined;
  try {
    server = await raceWithSignal(dependencies.connect(name, config, scope.signal), scope.signal, dependencies.cleanup);
    const tools = await raceWithSignal(dependencies.fetchTools(server, scope.signal), scope.signal);
    throwIfAborted(options.signal);
    dependencies.markConnected(name, configLabel(config), tools.length, extractToolInfo(tools, name));
    return tools;
  } catch (error) {
    if (server) dependencies.cleanup(server);
    if (options.signal?.aborted) throw abortReason(options.signal);
    const message = scope.timedOut()
      ? `Initialization timed out after ${options.initTimeoutMs}ms`
      : error instanceof Error
        ? error.message
        : String(error);
    dependencies.markFailed(name, configLabel(config), message);
    return [];
  } finally {
    scope.dispose();
  }
}

function cleanupConnection(connection: ConnectedMcpServer): void {
  // cleanup() removes the connection from the shared map synchronously before
  // awaiting transport shutdown. Do not let a broken transport extend startup.
  void connection.cleanup().catch(() => undefined);
}

function raceWithSignal<T>(
  operation: Promise<T>,
  signal?: AbortSignal,
  onLateResolve?: (value: T) => void,
): Promise<T> {
  if (!signal) return operation;

  return new Promise<T>((resolve, reject) => {
    let finished = false;
    const dispose = () => signal.removeEventListener('abort', onAbort);
    const onAbort = () => {
      if (finished) return;
      finished = true;
      dispose();
      reject(abortReason(signal));
    };

    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });

    operation.then(
      (value) => {
        if (finished) {
          onLateResolve?.(value);
          return;
        }
        finished = true;
        dispose();
        resolve(value);
      },
      (error) => {
        if (finished) return;
        finished = true;
        dispose();
        reject(error);
      },
    );
  });
}

export function createMcpInitScope(
  parentSignal?: AbortSignal,
  timeoutMs?: number,
  serverName = 'MCP server',
): McpInitScope {
  if (!Number.isInteger(timeoutMs) || (timeoutMs ?? 0) <= 0) {
    return { signal: parentSignal, dispose() {}, timedOut: () => false };
  }

  const controller = new AbortController();
  let didTimeOut = false;
  const onParentAbort = () => controller.abort(abortReason(parentSignal!));
  if (parentSignal?.aborted) onParentAbort();
  else parentSignal?.addEventListener('abort', onParentAbort, { once: true });

  const timer = setTimeout(() => {
    didTimeOut = true;
    controller.abort(new DOMException(`${serverName} initialization timed out after ${timeoutMs}ms`, 'TimeoutError'));
  }, timeoutMs);
  timer.unref?.();

  return {
    signal: controller.signal,
    dispose() {
      clearTimeout(timer);
      parentSignal?.removeEventListener('abort', onParentAbort);
    },
    timedOut: () => didTimeOut,
  };
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortReason(signal);
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new DOMException('The operation was aborted', 'AbortError');
}

export async function reconnectMcpServer(name: string, config: McpServerConfig): Promise<string> {
  const existing = connections.get(name);
  if (existing) await existing.cleanup();

  try {
    const server = await connectToServer(name, config);
    const tools = await fetchToolsForServer(server);
    markServerConnected(name, configLabel(config), tools.length, extractToolInfo(tools, name));

    const allTools: MicaTool[] = [...tools];
    for (const [serverName, connected] of connections) {
      if (serverName === name) continue;
      try {
        allTools.push(...(await fetchToolsForServer(connected)));
      } catch {
        // Keep other connections untouched if refresh fails.
      }
    }
    micaTools.registerMcp(allTools);
    return `已重连 ${name}，注册 ${tools.length} 个工具`;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    markServerFailed(name, configLabel(config), message);
    await refreshRegisteredToolsFromConnections();
    return `${name} 重连失败: ${message}`;
  }
}

export async function shutdownMcp(): Promise<void> {
  micaTools.unregisterMcp();
  await disconnectAll();
}

async function refreshRegisteredToolsFromConnections(): Promise<void> {
  const allTools: MicaTool[] = [];
  for (const server of connections.values()) {
    try {
      allTools.push(...(await fetchToolsForServer(server)));
    } catch {
      // Keep the registry consistent with servers that can still list tools.
    }
  }
  micaTools.registerMcp(allTools);
}
