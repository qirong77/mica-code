import type {
  ConfigWebFilePayload,
  ConfigWebMcpDetails,
  ConfigWebPluginsDetails,
  ConfigWebRolesDetails,
  ConfigWebSessionDetails,
  ConfigWebSessionsDetails,
  ConfigWebSkillsDetails,
  ConfigWebSyncDetails,
} from '../../src/shared/types.js';

export async function readConfigFile(): Promise<ConfigWebFilePayload> {
  const response = await fetch('/api/files/config');
  return readJson(response);
}

export async function writeConfigFile(content: string): Promise<ConfigWebFilePayload> {
  const response = await fetch('/api/files/config', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ content }),
  });
  return readJson(response);
}

export async function readMcpDetails(): Promise<ConfigWebMcpDetails> {
  const response = await fetch('/api/details/mcp');
  return readJson(response);
}

export async function readSkillsDetails(): Promise<ConfigWebSkillsDetails> {
  const response = await fetch('/api/details/skills');
  return readJson(response);
}

export async function readPluginsDetails(): Promise<ConfigWebPluginsDetails> {
  const response = await fetch('/api/details/plugins');
  return readJson(response);
}

export async function readSessionsDetails(): Promise<ConfigWebSessionsDetails> {
  const response = await fetch('/api/details/sessions');
  return readJson(response);
}

export async function writeSession(id: string, content: string): Promise<void> {
  const response = await fetch('/api/files/session', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id, content }),
  });
  await assertOk(response);
}

export async function readSessionDetails(id: string): Promise<ConfigWebSessionDetails> {
  const response = await fetch(`/api/details/session?id=${encodeURIComponent(id)}`);
  return readJson(response);
}

export async function readRolesDetails(): Promise<ConfigWebRolesDetails> {
  const response = await fetch('/api/details/roles');
  return readJson(response);
}

export async function readSyncDetails(): Promise<ConfigWebSyncDetails> {
  const response = await fetch('/api/details/sync');
  return readJson(response);
}

export async function writeSyncConfig(serverUrl: string, name?: string): Promise<ConfigWebSyncDetails> {
  const response = await fetch('/api/files/sync', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ serverUrl, name }),
  });
  return readJson(response);
}

export async function writeRole(name: string, content: string): Promise<ConfigWebRolesDetails> {
  const response = await fetch('/api/files/role', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name, content }),
  });
  return readJson(response);
}

export async function createRole(name: string): Promise<ConfigWebRolesDetails> {
  const response = await fetch('/api/files/role', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name, content: '' }),
  });
  return readJson(response);
}

export async function deleteRole(name: string): Promise<ConfigWebRolesDetails> {
  const response = await fetch('/api/files/role', {
    method: 'DELETE',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name }),
  });
  return readJson(response);
}

export async function writeMcpServer(name: string, content: string): Promise<ConfigWebMcpDetails> {
  const response = await fetch('/api/files/mcp', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name, content }),
  });
  return readJson(response);
}

export async function createMcpServer(name: string): Promise<ConfigWebMcpDetails> {
  const response = await fetch('/api/files/mcp', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name, content: '' }),
  });
  return readJson(response);
}

export async function deleteMcpServer(name: string): Promise<ConfigWebMcpDetails> {
  const response = await fetch('/api/files/mcp', {
    method: 'DELETE',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name }),
  });
  return readJson(response);
}

export async function writeSkill(name: string, content: string): Promise<ConfigWebSkillsDetails> {
  const response = await fetch('/api/files/skill', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name, content }),
  });
  return readJson(response);
}

export async function createSkill(name: string): Promise<ConfigWebSkillsDetails> {
  const response = await fetch('/api/files/skill', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name, content: '' }),
  });
  return readJson(response);
}

export async function deleteSkill(name: string): Promise<ConfigWebSkillsDetails> {
  const response = await fetch('/api/files/skill', {
    method: 'DELETE',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name }),
  });
  return readJson(response);
}

export function connectHeartbeat(onEvent?: (event: { type?: string }) => void): WebSocket {
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
}

async function readJson<T>(response: Response): Promise<T> {
  if (!response.ok) {
    throw new Error(await readResponseError(response));
  }
  return response.json();
}

async function assertOk(response: Response): Promise<void> {
  if (!response.ok) throw new Error(await readResponseError(response));
}

async function readResponseError(response: Response): Promise<string> {
  const errorPayload = (await response.json().catch(() => null)) as { error?: string } | null;
  return errorPayload?.error ?? `Request failed: ${response.status}`;
}
