import type { ConfigWebClient } from '@packages/mica-config-ui/web/api.js';
import type { ConfigWebActionName } from '@packages/mica-config-ui/src/server/actions.js';
import { createConfigDataClient } from '@packages/mica-config-ui/web/actionClient.js';
import { CONFIG_WEB_EVENTS_PATH, httpRoutes } from '../../src/httpRoutes.js';

export function createHttpConfigWebClient(): ConfigWebClient {
  return {
    ...createConfigDataClient(request),
    connectHeartbeat: (onEvent) => {
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const socket = new WebSocket(`${protocol}//${window.location.host}${CONFIG_WEB_EVENTS_PATH}`);
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

async function request(action: ConfigWebActionName, input: Record<string, unknown> = {}) {
  const { method, path, view } = httpRoutes[action];
  const query = new URLSearchParams();
  if (view) query.set('view', view);
  if (method === 'GET') {
    for (const [key, value] of Object.entries(input)) {
      if (key === 'tail') {
        if (value === true) query.set(key, '1');
      } else if (value !== undefined) {
        query.set(key, String(value));
      }
    }
  }
  const response = await fetch(query.size ? `${path}?${query}` : path, {
    method,
    ...(method === 'GET' ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) }),
  });
  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as { error?: string } | null;
    throw new Error(payload?.error ?? `Request failed: ${response.status}`);
  }
  return response.json();
}
