import React from 'react';
import { Box, Text } from '@anthropic/ink';
import { UIPanelPlugin } from '../MicaPlugin';
import { mcpServersAtom, type McpServerStatus } from '../../mcp/client.js';
import { loadMcpConfig } from '../../mcp/config.js';
import { reconnectMcpServer } from '../../mcp/index.js';

const STATUS_ICON: Record<McpServerStatus['status'], string> = {
  connecting: '○',
  connected: '✓',
  failed: '✗',
};

function statusColor(status: McpServerStatus['status']) {
  if (status === 'connected') return '#4CAF50';
  if (status === 'failed') return '#F44336';
  return '#FFC107';
}

interface PanelState {
  view: 'list' | 'detail';
  selectedIdx: number;
  detailServerIdx: number;
}

function ServerList({ servers, selectedIdx }: { servers: McpServerStatus[]; selectedIdx: number }) {
  if (servers.length === 0) {
    return <Text dimColor>  no servers configured</Text>;
  }

  return (
    <Box flexDirection="column">
      {servers.map((s, i) => {
        const isSelected = i === selectedIdx;
        return (
          <Box key={s.name} flexDirection="row">
            <Box width={2}>
              <Text color={isSelected ? 'claude' : undefined}>
                {isSelected ? '▶' : ' '}
              </Text>
            </Box>
            <Box width={4}>
              <Text color={statusColor(s.status)}>{STATUS_ICON[s.status]}</Text>
            </Box>
            <Box width={16}>
              <Text bold={isSelected}>{s.name}</Text>
            </Box>
            <Text dimColor>{s.url}</Text>
            {s.status === 'connected' && (
              <Text color="#4CAF50">  {s.toolCount} tools</Text>
            )}
            {s.status === 'failed' && s.error && (
              <Text color="#F44336">  {s.error.slice(0, 50)}</Text>
            )}
          </Box>
        );
      })}
    </Box>
  );
}

function ToolDetail({ server }: { server: McpServerStatus }) {
  if (server.tools.length === 0) {
    return (
      <Box flexDirection="column">
        <Box paddingBottom={1}>
          <Text bold>{server.name} — </Text>
          <Text dimColor>{server.url}</Text>
        </Box>
        <Text dimColor>  no tools available</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      <Box paddingBottom={1}>
        <Text bold>{server.name} — </Text>
        <Text dimColor>{server.url}</Text>
        <Text color="#4CAF50">  {server.tools.length} tools</Text>
      </Box>
      {server.tools.map((t) => (
        <Box key={t.name} flexDirection="row" paddingLeft={2}>
          <Box width={3}>
            <Text dimColor>•</Text>
          </Box>
          <Box width={30}>
            <Text>{t.name}</Text>
          </Box>
          <Text dimColor>{t.description.slice(0, 80)}</Text>
        </Box>
      ))}
    </Box>
  );
}

function McpPanel({ state }: { state: PanelState }) {
  const servers = mcpServersAtom.get();

  return (
    <Box flexDirection="column" paddingX={1}>
      <Box paddingBottom={1}>
        <Text bold>MCP Servers</Text>
      </Box>

      {state.view === 'list' && (
        <ServerList servers={servers} selectedIdx={state.selectedIdx} />
      )}

      {state.view === 'detail' && (
        <ToolDetail server={servers[state.detailServerIdx]} />
      )}

      <Box paddingTop={1}>
        {state.view === 'list' && (
          <Text dimColor>↑↓ navigate  ↵ tools  esc close</Text>
        )}
        {state.view === 'detail' && (
          <Text dimColor>esc back</Text>
        )}
      </Box>
    </Box>
  );
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
      { view: 'list', selectedIdx: 0, detailServerIdx: 0 },
      (_input, key, state, setState) => {
        if (key.escape) {
          if (state.view === 'detail') {
            setState({ ...state, view: 'list' });
            return true;
          }
          this.hideUI();
          return true;
        }

        if (state.view === 'list') {
          if (key.upArrow) {
            setState({
              ...state,
              selectedIdx: state.selectedIdx > 0 ? state.selectedIdx - 1 : servers.length - 1,
            });
            return true;
          }
          if (key.downArrow) {
            setState({
              ...state,
              selectedIdx: state.selectedIdx < servers.length - 1 ? state.selectedIdx + 1 : 0,
            });
            return true;
          }
          if (key.return) {
            setState({
              view: 'detail',
              selectedIdx: 0,
              detailServerIdx: state.selectedIdx,
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
