import type {
  ConfigWebConversationDetails,
  ConfigWebFilePayload,
  ConfigWebMcpDetails,
  ConfigWebPluginsDetails,
  ConfigWebRolesDetails,
  ConfigWebSessionDetails,
  ConfigWebSessionsDetails,
  ConfigWebSkillsDetails,
} from '../../src/shared/types.js';

const token = new URLSearchParams(window.location.search).get('token') ?? '';

export async function readConfigFile(): Promise<ConfigWebFilePayload> {
  const response = await fetch(`/api/files/config?token=${encodeURIComponent(token)}`);
  return readJson(response);
}

export async function writeConfigFile(content: string): Promise<ConfigWebFilePayload> {
  const response = await fetch(`/api/files/config?token=${encodeURIComponent(token)}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ content }),
  });
  return readJson(response);
}

export async function readMcpDetails(): Promise<ConfigWebMcpDetails> {
  const response = await fetch(`/api/details/mcp?token=${encodeURIComponent(token)}`);
  return readJson(response);
}

export async function readSkillsDetails(): Promise<ConfigWebSkillsDetails> {
  const response = await fetch(`/api/details/skills?token=${encodeURIComponent(token)}`);
  return readJson(response);
}

export async function readPluginsDetails(): Promise<ConfigWebPluginsDetails> {
  const response = await fetch(`/api/details/plugins?token=${encodeURIComponent(token)}`);
  return readJson(response);
}

export async function readSessionsDetails(): Promise<ConfigWebSessionsDetails> {
  const response = await fetch(`/api/details/sessions?token=${encodeURIComponent(token)}`);
  return readJson(response);
}

export async function readSessionDetails(id: string): Promise<ConfigWebSessionDetails> {
  const response = await fetch(`/api/details/session?token=${encodeURIComponent(token)}&id=${encodeURIComponent(id)}`);
  return readJson(response);
}

export async function readRolesDetails(): Promise<ConfigWebRolesDetails> {
  const response = await fetch(`/api/details/roles?token=${encodeURIComponent(token)}`);
  return readJson(response);
}

export async function writeRole(name: string, content: string): Promise<ConfigWebRolesDetails> {
  const response = await fetch(`/api/files/role?token=${encodeURIComponent(token)}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name, content }),
  });
  return readJson(response);
}

export async function createRole(name: string): Promise<ConfigWebRolesDetails> {
  const response = await fetch(`/api/files/role?token=${encodeURIComponent(token)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name, content: '' }),
  });
  return readJson(response);
}

export async function readConversationDetails(): Promise<ConfigWebConversationDetails | null> {
  const response = await fetch(`/api/details/conversation?token=${encodeURIComponent(token)}`);
  return readJson(response);
}

export function connectHeartbeat(onEvent?: (event: { type?: string }) => void): WebSocket | null {
  if (!token) return null;
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const socket = new WebSocket(`${protocol}//${window.location.host}/api/events?token=${encodeURIComponent(token)}`);
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
  const payload = (await response.json()) as T & { error?: string };
  if (!response.ok) throw new Error(payload.error ?? `Request failed: ${response.status}`);
  return payload;
}
