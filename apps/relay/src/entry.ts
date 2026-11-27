#!/usr/bin/env bun
import { resolve } from 'node:path';
import { REMOTE_APP_VERSION, type RegisterDeviceRequest } from '@packages/mica-remote-protocol/protocol.js';
import { RelayService, type RelayConnectionHandle } from './relay.js';
import { RelayStore } from './store.js';

function argValue(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  if (index === -1) return undefined;
  return argv[index + 1];
}

const argv = process.argv.slice(2);
const host = argValue(argv, '--host') ?? process.env.MICA_RELAY_HOST ?? '127.0.0.1';
const port = Number(argValue(argv, '--port') ?? process.env.MICA_RELAY_PORT ?? 8787);
const dataPath = resolve(
  argValue(argv, '--data') ?? process.env.MICA_RELAY_DATA ?? resolve(process.cwd(), 'relay-data', 'relay.json'),
);

if (!Number.isInteger(port) || port <= 0 || port > 65535) {
  console.error('invalid --port');
  process.exit(2);
}

const store = new RelayStore(dataPath);
const service = new RelayService(store);
const startedAt = Date.now();
const handles = new Map<unknown, RelayConnectionHandle>();

type WsHandle = { send(data: string): void; close(code?: number, reason?: string): void };
type UpgradeServer = { upgrade(request: Request): boolean };

const bun = Bun;
if (!bun) {
  console.error('mica remote relay must run under Bun');
  process.exit(2);
}

const server = bun.serve({
  hostname: host,
  port,
  maxRequestBodySize: 16 * 1024,
  async fetch(request: Request, bunServer: UpgradeServer) {
    const url = new URL(request.url);
    if (url.pathname === '/api/health') {
      const snapshot = store.snapshot;
      return Response.json({
        ok: true,
        app: 'mica-remote-relay',
        version: REMOTE_APP_VERSION,
        serverTime: new Date().toISOString(),
        uptimeSec: Math.round((Date.now() - startedAt) / 1000),
        devices: Object.keys(snapshot.devices).length,
        pairings: snapshot.pairings.filter((pairing) => !pairing.revokedAt).length,
        online: service.onlineCount,
      });
    }
    if (url.pathname === '/api/register' && request.method === 'POST') {
      let body: RegisterDeviceRequest;
      try {
        body = (await request.json()) as RegisterDeviceRequest;
      } catch {
        return Response.json({ ok: false, code: 'bad_request', error: 'body must be JSON' }, { status: 400 });
      }
      try {
        return Response.json(service.registerDevice(body));
      } catch (error) {
        const code = (error as { code?: string }).code ?? 'internal';
        const message = error instanceof Error ? error.message : String(error);
        const status = code === 'unauthorized' ? 401 : code === 'conflict' ? 409 : 400;
        return Response.json({ ok: false, code, error: message }, { status });
      }
    }
    if (url.pathname === '/ws') {
      if (bunServer.upgrade(request)) return undefined;
      return new Response('websocket upgrade failed', { status: 400 });
    }
    return new Response('mica remote relay\n', {
      headers: { 'content-type': 'text/plain; charset=utf-8' },
    });
  },
  websocket: {
    open(ws: WsHandle) {
      const handle = service.attach({
        send: (text) => ws.send(text),
        close: (code, reason) => ws.close(code, reason),
      });
      handles.set(ws, handle);
    },
    message(ws: WsHandle, message: string | Uint8Array) {
      const handle = handles.get(ws);
      if (!handle) return;
      const text = typeof message === 'string' ? message : Buffer.from(message).toString('utf8');
      handle.receive(text);
    },
    close(ws: WsHandle) {
      handles.get(ws)?.close();
      handles.delete(ws);
    },
  },
});

const sweep = setInterval(() => service.sweepInactive(), 30_000);
sweep.unref?.();

const shownHost = host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host;
console.log('Mica remote relay');
console.log(`  ws:    ws://${shownHost}:${port}/ws`);
console.log(`  data:  ${dataPath}`);
console.log(`  invite code: ${service.inviteCode}`);
console.log('  (设备注册需要邀请码；正文经端到端加密，中转机不保存消息内容)');

const shutdown = () => {
  clearInterval(sweep);
  server.stop(true);
  process.exit(0);
};
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
