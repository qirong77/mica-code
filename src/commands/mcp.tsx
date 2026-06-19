import React from 'react';
import { Box, Text } from '@anthropic/ink';
import { atom } from 'nanostores';
import { micaUI } from '@packages/mica-ui/index.js';
import { showMessage } from '../app/bootstrap.js';
import { micaMcp, type McpServerStatus } from '@packages/mica-mcp/index.js';
import { logRuntime } from '@packages/mica-logger/index.js';

type McpState =
  | { view: 'list'; selectedIdx: number }
  | { view: 'tools'; serverIdx: number; selectedIdx: number }
  | { view: 'detail'; serverIdx: number; toolIdx: number };

const STATUS_ICON: Record<McpServerStatus['status'], string> = {
  connecting: '○',
  connected: '✓',
  failed: '✗',
};

function statusColor(status: McpServerStatus['status']) {
  if (status === 'connected') return micaUI.theme.colors.success;
  if (status === 'failed') return micaUI.theme.colors.error;
  return micaUI.theme.colors.primary;
}

function typeColor(type: string) {
  if (type === 'string') return '#FFC107';
  if (type === 'number' || type === 'integer') return '#4FC3F7';
  if (type === 'boolean') return '#CE93D8';
  if (type === 'object') return '#81C784';
  if (type === 'array') return '#FF8A65';
  return undefined;
}

function widthOrDefault(values: number[], fallback: number) {
  return values.length > 0 ? Math.max(...values) : fallback;
}

export function registerMcpPlugin() {
  return {
    name: 'mcp',
    description: '列出 MCP 服务器和工具',
    action: (arg?: string) => {
      const trimmed = arg?.trim();
      if (trimmed?.startsWith('reconnect ')) {
        const serverName = trimmed.slice('reconnect '.length).trim();
        if (!serverName) {
          logRuntime('plugin.mcp', 'reconnect:missing_server', undefined, 'warn');
          showMessage('用法: /mcp reconnect <server>');
          return;
        }
        logRuntime('plugin.mcp', 'reconnect:requested', { server: serverName });
        void reconnectServer(serverName);
        return;
      }

      logRuntime('plugin.mcp', 'opened', { servers: micaMcp.servers.get().length });
      const panelState = atom<McpState>({ view: 'list', selectedIdx: 0 });

      function hide() {
        micaUI.panels.clearPluginUIs();
        logRuntime('plugin.mcp', 'closed');
      }

      function McpPanel() {
        const state = micaUI.useScheduleState(panelState);
        const servers = micaUI.useScheduleState(micaMcp.servers);

        if (state.view === 'list') {
          const nameWidth = widthOrDefault(
            servers.map((server) => server.name.length + 2),
            18,
          );

          return (
            <micaUI.Dialog
              title={`mcp (${servers.length})`}
              footer={<micaUI.KeyHints hints={['↑↓ navigate', '↵ tools', 'esc close']} />}
            >
              <micaUI.SelectList
                items={servers.map((server) => ({ key: server.name, label: server.name }))}
                selectedIdx={state.selectedIdx}
                empty={<Text dimColor>no mcp servers configured</Text>}
                renderItem={(item, isSelected) => {
                  const server = servers.find((entry) => entry.name === item.key);
                  if (!server) return null;
                  return (
                    <Box flexDirection="row">
                      <Box width={4}>
                        <Text color={statusColor(server.status)}>{STATUS_ICON[server.status]}</Text>
                      </Box>
                      <Box width={nameWidth}>
                        <Text bold={isSelected}>{server.name}</Text>
                      </Box>
                      <Text dimColor>{server.url}</Text>
                      {server.status === 'connected' ? (
                        <Text color={micaUI.theme.colors.success}>{`  ${server.toolCount} tools`}</Text>
                      ) : null}
                      {server.status === 'failed' && server.error ? (
                        <Text color={micaUI.theme.colors.error}>{`  ${server.error.slice(0, 40)}`}</Text>
                      ) : null}
                    </Box>
                  );
                }}
              />
            </micaUI.Dialog>
          );
        }

        if (state.view === 'tools') {
          const server = servers[state.serverIdx];
          return (
            <micaUI.Dialog
              title={`${server?.name ?? 'mcp'} tools`}
              footer={<micaUI.KeyHints hints={['↑↓ navigate', '↵ detail', 'esc back']} />}
            >
              <micaUI.SelectList
                items={(server?.tools ?? []).map((tool) => ({
                  key: tool.name,
                  label: tool.name,
                }))}
                selectedIdx={state.selectedIdx}
                empty={<Text dimColor>no tools available</Text>}
                renderItem={(item, isSelected) => {
                  const tool = server?.tools.find((entry) => entry.name === item.key);
                  if (!tool) return null;
                  return (
                    <Box flexDirection="row">
                      <Box width={30}>
                        <Text bold={isSelected}>{tool.name}</Text>
                      </Box>
                      <Text dimColor>{tool.description.slice(0, 70)}</Text>
                    </Box>
                  );
                }}
              />
            </micaUI.Dialog>
          );
        }

        const server = servers[state.serverIdx];
        const tool = server?.tools[state.toolIdx];
        const schema = (tool?.inputSchema ?? {}) as {
          type?: string;
          properties?: Record<string, { type?: string; description?: string }>;
          required?: string[];
        };
        const properties = schema.properties ?? {};
        const required = schema.required ?? [];

        return (
          <micaUI.Dialog title={`${server?.name ?? 'mcp'} / ${tool?.name ?? ''}`} footer={<micaUI.KeyHints hints={['esc back']} />}>
            <Box flexDirection="column">
              {tool?.description ? (
                <Box paddingBottom={1}>
                  <Text dimColor>{tool.description}</Text>
                </Box>
              ) : null}
              {Object.keys(properties).length === 0 ? (
                <Text dimColor>no parameters</Text>
              ) : (
                <Box flexDirection="column">
                  <Box paddingBottom={1}>
                    <Text bold>parameters</Text>
                  </Box>
                  {Object.entries(properties).map(([name, prop]) => (
                    <Box key={name} flexDirection="row">
                      <Box width={4}>
                        <Text color={required.includes(name) ? micaUI.theme.colors.error : micaUI.theme.colors.dim}>
                          {required.includes(name) ? '*' : ' '}
                        </Text>
                      </Box>
                      <Box width={20}>
                        <Text>{name}</Text>
                      </Box>
                      <Box width={12}>
                        <Text color={typeColor(prop.type || 'any')}>{prop.type || 'any'}</Text>
                      </Box>
                      <Text dimColor>{prop.description?.slice(0, 60) ?? ''}</Text>
                    </Box>
                  ))}
                </Box>
              )}
              {schema.type && schema.type !== 'object' ? (
                <Box paddingTop={1}>
                  <Text>{`input type: ${schema.type}`}</Text>
                </Box>
              ) : null}
            </Box>
          </micaUI.Dialog>
        );
      }

      micaUI.panels.setPluginUIs([
        {
          id: 'mcp-panel',
          component: McpPanel,
          onInput: (_input, key) => {
            const state = panelState.get();
            const servers = micaMcp.servers.get();

            if (key.escape) {
              if (state.view === 'detail') {
                logRuntime('plugin.mcp', 'view:tools', {
                  server: servers[state.serverIdx]?.name,
                  from: 'detail',
                });
                panelState.set({
                  view: 'tools',
                  serverIdx: state.serverIdx,
                  selectedIdx: state.toolIdx,
                });
                return true;
              }
              if (state.view === 'tools') {
                logRuntime('plugin.mcp', 'view:list', {
                  server: servers[state.serverIdx]?.name,
                  from: 'tools',
                });
                panelState.set({ view: 'list', selectedIdx: state.serverIdx });
                return true;
              }
              hide();
              return true;
            }

            if (state.view === 'list') {
              if (servers.length === 0) return true;
              if (key.upArrow) {
                panelState.set({
                  view: 'list',
                  selectedIdx: state.selectedIdx > 0 ? state.selectedIdx - 1 : servers.length - 1,
                });
                return true;
              }
              if (key.downArrow) {
                panelState.set({
                  view: 'list',
                  selectedIdx: state.selectedIdx < servers.length - 1 ? state.selectedIdx + 1 : 0,
                });
                return true;
              }
              if (key.return) {
                logRuntime('plugin.mcp', 'view:tools', {
                  server: servers[state.selectedIdx]?.name,
                  tools: servers[state.selectedIdx]?.tools.length ?? 0,
                });
                panelState.set({
                  view: 'tools',
                  serverIdx: state.selectedIdx,
                  selectedIdx: 0,
                });
                return true;
              }
              return false;
            }

            if (state.view === 'tools') {
              const toolCount = servers[state.serverIdx]?.tools.length ?? 0;
              if (toolCount === 0) return true;
              if (key.upArrow) {
                panelState.set({
                  view: 'tools',
                  serverIdx: state.serverIdx,
                  selectedIdx: state.selectedIdx > 0 ? state.selectedIdx - 1 : toolCount - 1,
                });
                return true;
              }
              if (key.downArrow) {
                panelState.set({
                  view: 'tools',
                  serverIdx: state.serverIdx,
                  selectedIdx: state.selectedIdx < toolCount - 1 ? state.selectedIdx + 1 : 0,
                });
                return true;
              }
              if (key.return) {
                logRuntime('plugin.mcp', 'view:detail', {
                  server: servers[state.serverIdx]?.name,
                  tool: servers[state.serverIdx]?.tools[state.selectedIdx]?.name,
                });
                panelState.set({
                  view: 'detail',
                  serverIdx: state.serverIdx,
                  toolIdx: state.selectedIdx,
                });
                return true;
              }
            }

            return false;
          },
        },
      ]);
    },
  } satisfies Parameters<typeof micaUI.dropdown.setQuickCommands>[0][number];
}

async function reconnectServer(name: string) {
  logRuntime('plugin.mcp', 'reconnect:start', { server: name });
  const config = await micaMcp.loadConfig();
  const server = config[name];
  if (!server) {
    logRuntime('plugin.mcp', 'reconnect:not_found', { server: name }, 'error');
    showMessage(`未找到 MCP 配置: ${name}`, 4000);
    return;
  }
  try {
    const message = await micaMcp.reconnectServer(name, server);
    showMessage(message, 4000);
    logRuntime('plugin.mcp', 'reconnect:done', { server: name, message });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logRuntime('plugin.mcp', 'reconnect:error', { server: name, message }, 'error');
    showMessage(`MCP reconnect failed: ${message}`, 4000);
  }
}
