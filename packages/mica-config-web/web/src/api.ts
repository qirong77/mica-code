import type {
  ConfigWebConversationDetails,
  ConfigWebConversationWorkspace,
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

export async function deleteRole(name: string): Promise<ConfigWebRolesDetails> {
  const response = await fetch(`/api/files/role?token=${encodeURIComponent(token)}`, {
    method: 'DELETE',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name }),
  });
  return readJson(response);
}

export async function writeMcpServer(name: string, content: string): Promise<ConfigWebMcpDetails> {
  const response = await fetch(`/api/files/mcp?token=${encodeURIComponent(token)}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name, content }),
  });
  return readJson(response);
}

export async function createMcpServer(name: string): Promise<ConfigWebMcpDetails> {
  const response = await fetch(`/api/files/mcp?token=${encodeURIComponent(token)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name, content: '' }),
  });
  return readJson(response);
}

export async function deleteMcpServer(name: string): Promise<ConfigWebMcpDetails> {
  const response = await fetch(`/api/files/mcp?token=${encodeURIComponent(token)}`, {
    method: 'DELETE',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name }),
  });
  return readJson(response);
}

export async function writeSkill(name: string, content: string): Promise<ConfigWebSkillsDetails> {
  const response = await fetch(`/api/files/skill?token=${encodeURIComponent(token)}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name, content }),
  });
  return readJson(response);
}

export async function createSkill(name: string): Promise<ConfigWebSkillsDetails> {
  const response = await fetch(`/api/files/skill?token=${encodeURIComponent(token)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name, content: '' }),
  });
  return readJson(response);
}

export async function deleteSkill(name: string): Promise<ConfigWebSkillsDetails> {
  const response = await fetch(`/api/files/skill?token=${encodeURIComponent(token)}`, {
    method: 'DELETE',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name }),
  });
  return readJson(response);
}

export async function readConversationDetails(): Promise<ConfigWebConversationDetails | null> {
  const response = await fetch(`/api/details/conversation?token=${encodeURIComponent(token)}`);
  return readJson(response);
}

export async function readConversationWorkspace(): Promise<ConfigWebConversationWorkspace> {
  const response = await fetch(`/api/conversation/workspace?token=${encodeURIComponent(token)}`);
  return readJson(response);
}

export async function createConversation(input: {
  title?: string;
  folderId?: string | null;
  providerId?: string;
  model?: string;
  effort?: string;
  role?: string;
} = {}): Promise<ConfigWebSessionDetails> {
  const response = await fetch(`/api/conversation?token=${encodeURIComponent(token)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  });
  return readJson(response);
}

export async function patchConversation(input: {
  id: string;
  title?: string;
  folderId?: string | null;
  pinned?: boolean;
  providerId?: string;
  model?: string;
  effort?: string;
  role?: string;
}): Promise<ConfigWebSessionDetails> {
  const response = await fetch(`/api/conversation?token=${encodeURIComponent(token)}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  });
  return readJson(response);
}

export async function deleteConversation(id: string): Promise<ConfigWebConversationWorkspace> {
  const response = await fetch(`/api/conversation?token=${encodeURIComponent(token)}`, {
    method: 'DELETE',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id }),
  });
  return readJson(response);
}

export async function clearConversation(id: string): Promise<ConfigWebSessionDetails> {
  const response = await fetch(`/api/conversation/clear?token=${encodeURIComponent(token)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id }),
  });
  return readJson(response);
}

export async function sendConversationMessage(id: string, content: string): Promise<ConfigWebSessionDetails> {
  const response = await fetch(`/api/conversation/send?token=${encodeURIComponent(token)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id, content }),
  });
  return readJson(response);
}

export async function createConversationFolder(name?: string): Promise<ConfigWebConversationWorkspace> {
  const response = await fetch(`/api/conversation/folder?token=${encodeURIComponent(token)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name }),
  });
  return readJson(response);
}

export async function patchConversationFolder(input: {
  id: string;
  name?: string;
  collapsed?: boolean;
}): Promise<ConfigWebConversationWorkspace> {
  const response = await fetch(`/api/conversation/folder?token=${encodeURIComponent(token)}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  });
  return readJson(response);
}

export async function deleteConversationFolder(id: string): Promise<ConfigWebConversationWorkspace> {
  const response = await fetch(`/api/conversation/folder?token=${encodeURIComponent(token)}`, {
    method: 'DELETE',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id }),
  });
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
