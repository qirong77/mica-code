import type { Plugin, WebSocket } from 'vite';
import { CONFIG_WEB_EVENTS_PATH } from '../httpRoutes.js';

/** Accept the heartbeat on Vite's own listener. Proxying an upgrade through Bun's node:http stalls the handshake. */
export function devHeartbeat(): Plugin {
  return {
    name: 'config-web-heartbeat',
    configureServer({ httpServer }) {
      if (!httpServer) return;
      // Bun supplies the ws module for Node-compatible HTTP upgrade listeners.
      const { WebSocketServer } = import.meta.require('ws') as typeof WebSocket;
      const sockets = new WebSocketServer({ noServer: true });
      httpServer.on('upgrade', (req, socket, head) => {
        if (req.url?.split('?')[0] === CONFIG_WEB_EVENTS_PATH) sockets.handleUpgrade(req, socket, head, () => {});
      });
      httpServer.once('close', () => {
        for (const client of sockets.clients) client.terminate();
        sockets.close();
      });
    },
  };
}
