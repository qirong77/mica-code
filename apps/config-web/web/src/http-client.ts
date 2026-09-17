import type { ConfigWebClient } from '@packages/mica-config-ui/web/index.js';
import type {
  ConfigWebContextAnalysis,
  ConfigWebConversationItem,
  ConfigWebConversationPage,
  ConfigWebFilePayload,
  ConfigWebMcpDetails,
  ConfigWebPluginsDetails,
  ConfigWebRolesDetails,
  ConfigWebSessionDetails,
  ConfigWebSessionsDetails,
  ConfigWebSkillsDetails,
} from '@packages/mica-config-ui/src/shared/types.js';

/**
 * 浏览器端的 Config Web 数据源：走同源的 `/api/*`（由 apps/config-web 的 Bun 服务转发到
 * 共享动作表）。桌面端有另一份实现走运行时 IPC，页面组件对两者一视同仁。
 */
export function createHttpConfigWebClient(): ConfigWebClient {
  return {
    readConfigFile: () => request<ConfigWebFilePayload>('/api/files/config'),
    writeConfigFile: (content) =>
      request<ConfigWebFilePayload>('/api/files/config', { method: 'PUT', body: { content } }),

    readMcpDetails: () => request<ConfigWebMcpDetails>('/api/details/mcp'),
    createMcpServer: (name, content = '') =>
      request<ConfigWebMcpDetails>('/api/files/mcp', { method: 'POST', body: { name, content } }),
    writeMcpServer: (name, content) =>
      request<ConfigWebMcpDetails>('/api/files/mcp', { method: 'PUT', body: { name, content } }),
    deleteMcpServer: (name) =>
      request<ConfigWebMcpDetails>('/api/files/mcp', { method: 'DELETE', body: { name } }),

    readSkillsDetails: () => request<ConfigWebSkillsDetails>('/api/details/skills'),
    createSkill: (name, content = '') =>
      request<ConfigWebSkillsDetails>('/api/files/skill', { method: 'POST', body: { name, content } }),
    writeSkill: (name, content) =>
      request<ConfigWebSkillsDetails>('/api/files/skill', { method: 'PUT', body: { name, content } }),
    deleteSkill: (name) =>
      request<ConfigWebSkillsDetails>('/api/files/skill', { method: 'DELETE', body: { name } }),

    readRolesDetails: () => request<ConfigWebRolesDetails>('/api/details/roles'),
    createRole: (name, content = '') =>
      request<ConfigWebRolesDetails>('/api/files/role', { method: 'POST', body: { name, content } }),
    writeRole: (name, content) =>
      request<ConfigWebRolesDetails>('/api/files/role', { method: 'PUT', body: { name, content } }),
    deleteRole: (name) =>
      request<ConfigWebRolesDetails>('/api/files/role', { method: 'DELETE', body: { name } }),

    readPluginsDetails: () => request<ConfigWebPluginsDetails>('/api/details/plugins'),

    readSessionsDetails: () => request<ConfigWebSessionsDetails>('/api/details/sessions'),
    readSessionDetails: (id) => request<ConfigWebSessionDetails>(`/api/details/session?id=${encodeURIComponent(id)}`),
    readSessionContent: (id) =>
      request<{ content: string }>(`/api/details/session?id=${encodeURIComponent(id)}&view=json`),
    readSessionConversationPage: (id, offset, limit, tail = false) =>
      request<ConfigWebConversationPage>(
        `/api/details/session?id=${encodeURIComponent(id)}&view=conversation&offset=${offset}&limit=${limit}${
          tail ? '&tail=1' : ''
        }`,
      ),
    readSessionItem: (id, sequence) =>
      request<ConfigWebConversationItem>(
        `/api/details/session?id=${encodeURIComponent(id)}&view=item&sequence=${encodeURIComponent(String(sequence))}`,
      ),
    readSessionContextAnalysis: (id) =>
      request<ConfigWebContextAnalysis>(`/api/details/session?id=${encodeURIComponent(id)}&view=context`),
    writeSession: (id, content) =>
      request<unknown>('/api/files/session', { method: 'PUT', body: { id, content } }),

    connectHeartbeat: (onEvent) => {
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const socket = new WebSocket(`${protocol}//${window.location.host}/api/events`);
      if (onEvent) {
        socket.addEventListener('message', (message) => {
          try {
            onEvent(JSON.parse(String(message.data)) as { type?: string });
          } catch {
            // Ignore malformed server events; the socket still acts as the process heartbeat.
          }
        });
      }
      return socket;
    },
  };
}

async function request<T>(
  path: string,
  options: { method?: string; body?: unknown } = {},
): Promise<T> {
  const response = await fetch(path, {
    method: options.method ?? 'GET',
    ...(options.body === undefined
      ? {}
      : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(options.body) }),
  });
  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as { error?: string } | null;
    throw new Error(payload?.error ?? `Request failed: ${response.status}`);
  }
  return (await response.json()) as T;
}
