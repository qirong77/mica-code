import type {
  ConfigWebFilePayload,
  ConfigWebMcpDetails,
  ConfigWebPluginsDetails,
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

export function connectHeartbeat(): WebSocket | null {
  if (!token) return null;
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return new WebSocket(`${protocol}//${window.location.host}/api/events?token=${encodeURIComponent(token)}`);
}

async function readJson<T>(response: Response): Promise<T> {
  const payload = (await response.json()) as T & { error?: string };
  if (!response.ok) throw new Error(payload.error ?? `Request failed: ${response.status}`);
  return payload;
}
