import React from 'react';
import { Box, Text } from '@anthropic/ink';
import { UIPanelPlugin } from '../MicaPlugin';
import { mcpServersAtom, type McpServerStatus, type McpToolInfo } from '../../mcp/client.js';
import { loadMcpConfig } from '../../mcp/config.js';
import { reconnectMcpServer } from '../../mcp/index.js';
import { Dialog, SelectList, KeyHints, DetailView } from '../../components/ui/primitives/index.js';
import { C } from '../../components/ui/data.js';
import type { SelectItem } from '../../components/ui/primitives/index.js';

const STATUS_ICON: Record<McpServerStatus['status'], string> = {
  connecting: '○',
  connected: '✓',
  failed: '✗',
};

function statusColor(status: McpServerStatus['status']) {
  if (status === 'connected') return C.success;
  if (status === 'failed') return C.error;
  return C.warning;
}

function typeColor(type: string) {
  if (type === 'string') return '#FFC107';
  if (type === 'number' || type === 'integer') return '#4FC3F7';
  if (type === 'boolean') return '#CE93D8';
  if (type === 'object') return '#81C784';
  if (type === 'array') return '#FF8A65';
  return undefined;
}

type ViewState =
  | { view: 'list'; selectedIdx: number }
  | { view: 'tools'; serverIdx: number; selectedIdx: number }
  | { view: 'toolDetail'; serverIdx: number; toolIdx: number };

interface PanelState {
  state: ViewState;
  _servers: McpServerStatus[];
}

function ServerList({ servers, selectedIdx }: { servers: McpServerStatus[]; selectedIdx: number }) {
  const nameMax = Math.max(...servers.map((s) => s.name.length));
  const urlMax = Math.max(...servers.map((s) => s.url.length));
  const configMax = Math.max(...servers.map((s) => s.configPath.length));

  return (
    <SelectList
      items={servers.map((s) => ({ key: s.name, label: s.name }))}
      selectedIdx={selectedIdx}
      empty={<Text dimColor>  no servers configured</Text>}
      renderItem={(item, isSelected) => {
        const s = servers.find((x) => x.name === item.key)!;
        return (
          <Box flexDirection="row">
            <Box width={4}>
              <Text color={statusColor(s.status)}>{STATUS_ICON[s.status]}</Text>
            </Box>
            <Box width={nameMax + 2}>
              <Text bold={isSelected}>{s.name}</Text>
            </Box>
            <Box width={2}>
              <Text>{' '}</Text>
            </Box>
            <Box width={urlMax}>
              <Text dimColor>{s.url}</Text>
            </Box>
            <Box width={2}>
              <Text>{' '}</Text>
            </Box>
            <Box width={configMax}>
              <Text dimColor>{s.configPath}</Text>
            </Box>
            {s.status === 'connected' && (
              <Text color={C.success}>  {s.toolCount} tools</Text>
            )}
            {s.status === 'failed' && s.error && (
              <Text color={C.error}>  {s.error.slice(0, 50)}</Text>
            )}
          </Box>
        );
      }}
    />
  );
}

function ToolList({
  server,
  selectedIdx,
}: {
  server: McpServerStatus;
  selectedIdx: number;
}) {
  return (
    <Box flexDirection="column">
      <Box paddingBottom={1}>
        <Text bold>{server.name} — </Text>
        <Text dimColor>{server.url}</Text>
        <Text color={C.success}>  {server.tools.length} tools</Text>
      </Box>
      <SelectList
        items={server.tools.map((t) => ({ key: t.name, label: t.name }))}
        selectedIdx={selectedIdx}
        empty={<Text dimColor>  no tools available</Text>}
        renderItem={(item, isSelected) => {
          const t = server.tools.find((x) => x.name === item.key)!;
          return (
            <Box flexDirection="row">
              <Box width={30}>
                <Text bold={isSelected}>{t.name}</Text>
              </Box>
              <Text dimColor>{t.description.slice(0, 80)}</Text>
            </Box>
          );
        }}
      />
    </Box>
  );
}

function ToolDetail({ tool, serverName }: { tool: McpToolInfo; serverName: string }) {
  const schema = tool.inputSchema as {
    type?: string;
    properties?: Record<string, { type?: string; description?: string }>;
    required?: string[];
  };
  const properties = schema.properties || {};
  const required = schema.required || [];
  const propKeys = Object.keys(properties);

  return (
    <DetailView header={<Text bold>{serverName} / {tool.name}</Text>}>
      {tool.description && (
        <Box paddingBottom={1}>
          <Text dimColor>{tool.description}</Text>
        </Box>
      )}

      {propKeys.length > 0 && (
        <Box flexDirection="column" paddingBottom={1}>
          <Box paddingBottom={1}>
            <Text bold>参数:</Text>
          </Box>
          {propKeys.map((key) => {
            const prop = properties[key];
            const isRequired = required.includes(key);
            const typeName = prop.type || 'any';
            return (
              <Box key={key} flexDirection="row" paddingLeft={2}>
                <Box width={4}>
                  {isRequired ? (
                    <Text color={C.error}>*</Text>
                  ) : (
                    <Text>{' '}</Text>
                  )}
                </Box>
                <Box width={20}>
                  <Text>{key}</Text>
                </Box>
                <Box width={10}>
                  <Text color={typeColor(typeName)}>{typeName}</Text>
                </Box>
                {prop.description && (
                  <Text dimColor>{prop.description.slice(0, 60)}</Text>
                )}
              </Box>
            );
          })}
          <Box paddingLeft={4} paddingTop={1}>
            <Text dimColor>* 必需参数</Text>
          </Box>
        </Box>
      )}

      {propKeys.length === 0 && (
        <Text dimColor>  无参数</Text>
      )}

      {schema.type && schema.type !== 'object' && (
        <Box paddingTop={1}>
          <Text>输入类型: </Text>
          <Text color={typeColor(schema.type)}>{schema.type}</Text>
        </Box>
      )}
    </DetailView>
  );
}

function McpPanel({ state: panelState }: { state: PanelState }) {
  const servers = panelState._servers;
  const s = panelState.state;

  if (s.view === 'list') {
    return (
      <Dialog title="MCP Servers" footer={<KeyHints hints={['↑↓ navigate', '↵ tools', 'esc close']} />}>
        <ServerList servers={servers} selectedIdx={s.selectedIdx} />
      </Dialog>
    );
  }

  if (s.view === 'tools') {
    return (
      <Dialog title={`${servers[s.serverIdx].name} tools`} footer={<KeyHints hints={['↑↓ navigate', '↵ details', 'esc back']} />}>
        <ToolList server={servers[s.serverIdx]} selectedIdx={s.selectedIdx} />
      </Dialog>
    );
  }

  return <ToolDetail tool={servers[s.serverIdx].tools[s.toolIdx]} serverName={servers[s.serverIdx].name} />;
}

export class QuickCommandMcpPlugin extends UIPanelPlugin {
  onInstall(): void {
    this.addQuickCommand({
      name: 'mcp',
      description: '查看/管理 MCP 服务器',
      action: (arg?: string) => {
        const trimmed = arg?.trim();

        if (trimmed && trimmed.startsWith('reconnect ')) {
          const serverName = trimmed.slice('reconnect '.length).trim();
          if (!serverName) {
            this.showMessage('用法: /mcp reconnect <服务器名>');
            return;
          }
          this._reconnect(serverName);
          return;
        }

        this._showPanel();
      },
    });
  }

  private _showPanel() {
    const servers = mcpServersAtom.get();

    this.showUI<PanelState>(
      McpPanel,
      { state: { view: 'list', selectedIdx: 0 }, _servers: servers },
      (_input, key, state, setState) => {
        const s = state.state;
        const servers = state._servers;

        if (key.escape) {
          if (s.view === 'toolDetail') {
            setState({
              state: { view: 'tools', serverIdx: s.serverIdx, selectedIdx: s.toolIdx },
              _servers: servers,
            });
            return true;
          }
          if (s.view === 'tools') {
            setState({ state: { view: 'list', selectedIdx: s.serverIdx }, _servers: servers });
            return true;
          }
          this.hideUI();
          return true;
        }

        if (s.view === 'list') {
          if (key.upArrow) {
            setState({
              state: { view: 'list', selectedIdx: s.selectedIdx > 0 ? s.selectedIdx - 1 : servers.length - 1 },
              _servers: servers,
            });
            return true;
          }
          if (key.downArrow) {
            setState({
              state: { view: 'list', selectedIdx: s.selectedIdx < servers.length - 1 ? s.selectedIdx + 1 : 0 },
              _servers: servers,
            });
            return true;
          }
          if (key.return) {
            setState({
              state: { view: 'tools', serverIdx: s.selectedIdx, selectedIdx: 0 },
              _servers: servers,
            });
            return true;
          }
        }

        if (s.view === 'tools') {
          const tools = servers[s.serverIdx].tools;
          if (key.upArrow) {
            setState({
              state: { view: 'tools', serverIdx: s.serverIdx, selectedIdx: s.selectedIdx > 0 ? s.selectedIdx - 1 : tools.length - 1 },
              _servers: servers,
            });
            return true;
          }
          if (key.downArrow) {
            setState({
              state: { view: 'tools', serverIdx: s.serverIdx, selectedIdx: s.selectedIdx < tools.length - 1 ? s.selectedIdx + 1 : 0 },
              _servers: servers,
            });
            return true;
          }
          if (key.return) {
            setState({
              state: { view: 'toolDetail', serverIdx: s.serverIdx, toolIdx: s.selectedIdx },
              _servers: servers,
            });
            return true;
          }
        }

        return false;
      },
    );
  }

  private async _reconnect(serverName: string) {
    const configs = await loadMcpConfig();
    const config = configs[serverName];
    if (!config) {
      this.showMessage(`未找到 MCP 服务器: ${serverName}`);
      return;
    }
    this.showMessage(`正在重连 ${serverName}...`);
    const result = await reconnectMcpServer(serverName, config);
    this.showMessage(result);
  }
}