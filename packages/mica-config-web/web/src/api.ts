import type {
  ConfigWebConversationDetails,
  ConfigWebConversationStreamEvent,
  ConfigWebConversationWorkspace,
  ConfigWebFilePayload,
  ConfigWebMcpDetails,
  ConfigWebPluginsDetails,
  ConfigWebRolesDetails,
  ConfigWebSessionDetails,
  ConfigWebSessionsDetails,
  ConfigWebSkillsDetails,
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

export async function readSessionDetails(id: string): Promise<ConfigWebSessionDetails> {
  const response = await fetch(`/api/details/session?id=${encodeURIComponent(id)}`);
  return readJson(response);
}

export async function readRolesDetails(): Promise<ConfigWebRolesDetails> {
  const response = await fetch('/api/details/roles');
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

export async function readConversationDetails(): Promise<ConfigWebConversationDetails | null> {
  const response = await fetch('/api/details/conversation');
  return readJson(response);
}

export async function readConversationWorkspace(): Promise<ConfigWebConversationWorkspace> {
  const response = await fetch('/api/conversation/workspace');
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
  const response = await fetch('/api/conversation', {
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
  const response = await fetch('/api/conversation', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  });
  return readJson(response);
}

export async function deleteConversation(id: string): Promise<ConfigWebConversationWorkspace> {
  const response = await fetch('/api/conversation', {
    method: 'DELETE',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id }),
  });
  return readJson(response);
}

export async function clearConversation(id: string): Promise<ConfigWebSessionDetails> {
  const response = await fetch('/api/conversation/clear', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id }),
  });
  return readJson(response);
}

export async function sendConversationMessage(id: string, content: string): Promise<ConfigWebSessionDetails> {
  const response = await fetch('/api/conversation/send', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id, content }),
  });
  return readJson(response);
}

export async function streamConversationMessage(
  id: string,
  content: string,
  onEvent: (event: ConfigWebConversationStreamEvent) => void,
  signal?: AbortSignal,
): Promise<ConfigWebSessionDetails> {
  const response = await fetch('/api/conversation/send-stream', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id, content }),
    signal,
  });
  if (!response.ok) throw new Error(await readResponseError(response));
  if (!response.body) throw new Error('浏览器未提供流式响应体');

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let completed: ConfigWebSessionDetails | null = null;

  const consumeLine = (line: string) => {
    if (!line.trim()) return;
    const event = JSON.parse(line) as ConfigWebConversationStreamEvent;
    onEvent(event);
    if (event.type === 'done') completed = event.session;
    if (event.type === 'error') throw new Error(event.message);
  };

  try {
    while (true) {
      const { value, done } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) consumeLine(line);
      if (done) break;
    }
    consumeLine(buffer);
    if (!completed) throw new Error('会话流在完成前已关闭');
    return completed;
  } finally {
    if (!completed) await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

export async function createConversationFolder(input: { name?: string } = {}): Promise<ConfigWebConversationWorkspace> {
  const response = await fetch('/api/conversation/folder', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  });
  return readJson(response);
}

export async function patchConversationFolder(input: {
  id: string;
  name?: string;
  collapsed?: boolean;
}): Promise<ConfigWebConversationWorkspace> {
  const response = await fetch('/api/conversation/folder', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  });
  return readJson(response);
}

export async function deleteConversationFolder(id: string): Promise<ConfigWebConversationWorkspace> {
  const response = await fetch('/api/conversation/folder', {
    method: 'DELETE',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id }),
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

async function readResponseError(response: Response): Promise<string> {
  const errorPayload = (await response.json().catch(() => null)) as { error?: string } | null;
  return errorPayload?.error ?? `Request failed: ${response.status}`;
}
