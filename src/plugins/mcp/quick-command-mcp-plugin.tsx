import React from 'react';
import { Box, Text } from '@anthropic/ink';
import { MicaPlugin } from '../MicaPlugin';
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

function McpStatusList({ state }: { state: { servers: McpServerStatus[] } }) {
  const servers = state.servers;

  if (servers.length === 0) {
    return (
      <Box flexDirection="column" paddingX={1}>
        <Box paddingBottom={1}>
          <Text bold>MCP Servers</Text>
        </Box>
        <Text dimColor>no servers configured</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" paddingX={1}>
      <Box paddingBottom={1}>
        <Text bold>MCP Servers</Text>
      </Box>
      {servers.map((s) => (
        <Box key={s.name} flexDirection="row">
          <Box width={4}>
            <Text color={statusColor(s.status)}>{STATUS_ICON[s.status]}</Text>
          </Box>
          <Box width={16}>
            <Text>{s.name}</Text>
          </Box>
          <Text dimColor>{s.url}</Text>
          {s.status === 'connected' && (
            <Text color="#4CAF50">  {s.toolCount} tools</Text>
          )}
          {s.status === 'failed' && s.error && (
            <Text color="#F44336">  {s.error.slice(0, 50)}</Text>
          )}
        </Box>
      ))}
      <Box paddingTop={1}>
        <Text dimColor>/mcp reconnect &lt;name&gt; to reconnect</Text>
      </Box>
    </Box>
  );
}

export class QuickCommandMcpPlugin extends MicaPlugin {
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

        this._showStatus();
      },
    });
  }

  private _showStatus() {
    const servers = mcpServersAtom.get();
    this.showUI<{ servers: McpServerStatus[] }>(
      McpStatusList,
      { servers },
      (_input, key) => {
        if (key.escape || key.return) {
          this.hideUI();
          return true;
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
