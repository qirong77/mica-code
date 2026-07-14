import { Box, Text } from '@anthropic/ink';
import { atom } from 'nanostores';
import { micaUi } from '@packages/mica-ui/index.js';
import { micaMcp, type McpServerStatus } from '@packages/mica-mcp/index.js';
import type { CommandRuntimeServices } from '../services.js';
import { moveSelection } from '../shared/commandInput.js';

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
  if (status === 'connected') return micaUi.theme.colors.success;
  if (status === 'failed') return micaUi.theme.colors.error;
  return micaUi.theme.colors.primary;
}

function typeColor(type: string) {
  if (type === 'string') return '#FFC107';
  if (type === 'number' || type === 'integer') return '#4FC3F7';
  if (type === 'boolean') return '#CE93D8';
  if (type === 'object') return '#81C784';
  if (type === 'array') return '#FF8A65';
  return undefined;
}

export function createMcpCommand(services: CommandRuntimeServices) {
  return {
    name: 'mcp',
    description: '列出 MCP 服务器和工具；/mcp reconnect <server> 重连指定服务',
    completionItems: () =>
      micaMcp.servers.get().map((server) => ({
        arg: `reconnect ${server.name}`,
        description: `重连 ${server.name}`,
      })),
    action: (arg?: string) => {
      const trimmed = arg?.trim();
      if (trimmed?.startsWith('reconnect ')) {
        const serverName = trimmed.slice('reconnect '.length).trim();
        if (!serverName) {
          services.showMessage('用法: /mcp reconnect <server>');
          return;
        }
        void reconnectServer(serverName, services);
        return;
      }
      const panelState = atom<McpState>({ view: 'list', selectedIdx: 0 });

      function hide() {
        micaUi.panels.clearPluginUIs();
      }

      function McpPanel() {
        const state = micaUi.useScheduleState(panelState);
        const servers = micaUi.useScheduleState(micaMcp.servers);

        if (state.view === 'list') {
          const nameWidth = micaUi.getOneLineColumnWidth(
            servers.map((server) => server.name),
            { min: 18, max: 32, padding: 1 },
          );

          return (
            <micaUi.Dialog
              title={`mcp (${servers.length})`}
              footer={<micaUi.KeyHints hints={['↑↓ navigate', '↵ tools', 'esc close']} />}
            >
              <micaUi.SelectList
                items={servers.map((server) => ({ key: server.name, label: server.name }))}
                selectedIdx={state.selectedIdx}
                itemGap={0}
                empty={<Text dimColor>no mcp servers configured</Text>}
                renderItem={(item, isSelected) => {
                  const server = servers.find((entry) => entry.name === item.key);
                  if (!server) return null;
                  return (
                    <micaUi.OneLineItem
                      cells={[
                        {
                          key: 'icon',
                          content: STATUS_ICON[server.status],
                          width: 2,
                          color: statusColor(server.status),
                        },
                        {
                          key: 'name',
                          content: server.name,
                          width: nameWidth,
                          color: isSelected ? micaUi.theme.colors.accent : undefined,
                          bold: isSelected,
                        },
                        {
                          key: 'status',
                          content: server.status,
                          width: 12,
                          flexShrink: 0,
                          color: statusColor(server.status),
                        },
                        {
                          key: 'tools',
                          content: server.status === 'connected' ? `${server.toolCount} tools` : '-',
                          width: 10,
                          flexShrink: 0,
                          color: server.status === 'connected' ? micaUi.theme.colors.success : micaUi.theme.colors.dim,
                        },
                        {
                          key: 'detail',
                          content: server.status === 'failed' ? server.error : server.url,
                          flexGrow: 1,
                          flexShrink: 1,
                          minWidth: 0,
                          color: server.status === 'failed' ? micaUi.theme.colors.error : undefined,
                          dimColor: server.status !== 'failed',
                        },
                      ]}
                    />
                  );
                }}
              />
            </micaUi.Dialog>
          );
        }

        if (state.view === 'tools') {
          const server = servers[state.serverIdx];
          const toolNameWidth = micaUi.getOneLineColumnWidth(
            (server?.tools ?? []).map((tool) => tool.name),
            { min: 24, max: 34, padding: 1 },
          );
          return (
            <micaUi.Dialog
              title={`${server?.name ?? 'mcp'} tools`}
              footer={<micaUi.KeyHints hints={['↑↓ navigate', '↵ detail', 'esc back']} />}
            >
              <micaUi.SelectList
                items={(server?.tools ?? []).map((tool) => ({
                  key: tool.name,
                  label: tool.name,
                }))}
                selectedIdx={state.selectedIdx}
                itemGap={0}
                empty={<Text dimColor>no tools available</Text>}
                renderItem={(item, isSelected) => {
                  const tool = server?.tools.find((entry) => entry.name === item.key);
                  if (!tool) return null;
                  return (
                    <micaUi.OneLineItem
                      cells={[
                        {
                          key: 'name',
                          content: tool.name,
                          width: toolNameWidth,
                          color: isSelected ? micaUi.theme.colors.accent : undefined,
                          bold: isSelected,
                        },
                        {
                          key: 'description',
                          content: tool.description,
                          flexGrow: 1,
                          minWidth: 0,
                          dimColor: true,
                        },
                      ]}
                    />
                  );
                }}
              />
            </micaUi.Dialog>
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
        const parameterNameWidth = micaUi.getOneLineColumnWidth(Object.keys(properties), {
          min: 16,
          max: 28,
          padding: 1,
        });
        const parameterTypeWidth = micaUi.getOneLineColumnWidth(
          Object.values(properties).map((prop) => prop.type || 'any'),
          { min: 8, max: 14, padding: 1 },
        );

        return (
          <micaUi.Dialog
            title={`${server?.name ?? 'mcp'} / ${tool?.name ?? ''}`}
            footer={<micaUi.KeyHints hints={['esc back']} />}
          >
            <micaUi.BottomScrollBox>
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
                    <micaUi.OneLineItem
                      key={name}
                      cells={[
                        {
                          key: 'required',
                          content: required.includes(name) ? '*' : ' ',
                          width: 2,
                          color: required.includes(name) ? micaUi.theme.colors.error : micaUi.theme.colors.dim,
                        },
                        {
                          key: 'name',
                          content: name,
                          width: parameterNameWidth,
                        },
                        {
                          key: 'type',
                          content: prop.type || 'any',
                          width: parameterTypeWidth,
                          color: typeColor(prop.type || 'any'),
                        },
                        {
                          key: 'description',
                          content: prop.description ?? '',
                          flexGrow: 1,
                          minWidth: 0,
                          dimColor: true,
                        },
                      ]}
                    />
                  ))}
                </Box>
              )}
              {schema.type && schema.type !== 'object' ? (
                <Box paddingTop={1}>
                  <Text>{`input type: ${schema.type}`}</Text>
                </Box>
              ) : null}
            </micaUi.BottomScrollBox>
          </micaUi.Dialog>
        );
      }

      micaUi.panels.setExclusivePluginUI({
        id: 'mcp-panel',
        component: McpPanel,
        onInput: (_input, key) => {
          const state = panelState.get();
          const servers = micaMcp.servers.get();

          if (key.escape) {
            if (state.view === 'detail') {
              panelState.set({
                view: 'tools',
                serverIdx: state.serverIdx,
                selectedIdx: state.toolIdx,
              });
              return true;
            }
            if (state.view === 'tools') {
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
                selectedIdx: moveSelection(state.selectedIdx, servers.length, -1),
              });
              return true;
            }
            if (key.downArrow) {
              panelState.set({
                view: 'list',
                selectedIdx: moveSelection(state.selectedIdx, servers.length, 1),
              });
              return true;
            }
            if (key.return) {
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
                selectedIdx: moveSelection(state.selectedIdx, toolCount, -1),
              });
              return true;
            }
            if (key.downArrow) {
              panelState.set({
                view: 'tools',
                serverIdx: state.serverIdx,
                selectedIdx: moveSelection(state.selectedIdx, toolCount, 1),
              });
              return true;
            }
            if (key.return) {
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
      });
    },
  } satisfies Parameters<typeof micaUi.dropdown.setQuickCommands>[0][number];
}

async function reconnectServer(name: string, services: CommandRuntimeServices) {
  const config = await micaMcp.loadConfig();
  const server = config[name];
  if (!server) {
    services.showMessage(`未找到 MCP 配置: ${name}`, 4000);
    return;
  }
  try {
    const message = await micaMcp.reconnectServer(name, server);
    services.showMessage(message, 4000);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    services.showMessage(`MCP reconnect failed: ${message}`, 4000);
  }
}
