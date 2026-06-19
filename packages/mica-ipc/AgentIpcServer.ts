import { existsSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:net';
import type { RuntimeController } from '@packages/mica-runtime/index.js';
import { JsonLineConnection } from './jsonLine.js';
import { ControlLock } from './ControlLock.js';
import {
  MICA_AGENT_RPC_PROTOCOL,
  MICA_AGENT_RPC_VERSION,
  type AttachParams,
  type HelloParams,
  type RpcRequest,
  type RpcResponse,
} from './protocol.js';

export class AgentIpcServer {
  private server: Server | null = null;
  private seq = 0;
  private readonly control = new ControlLock();

  constructor(
    private readonly options: {
      agentId: string;
      socketPath: string;
      runtime: RuntimeController;
      onControlChanged?: (state: ReturnType<ControlLock['getState']>) => void;
    },
  ) {}

  async start(): Promise<void> {
    if (existsSync(this.options.socketPath)) rmSync(this.options.socketPath, { force: true });
    this.server = createServer((socket) => {
      const connection = new JsonLineConnection(socket);
      const runtimeDisposable = this.options.runtime.events.on('event', (event) => {
        connection.send({ type: 'event', event: event.type, seq: ++this.seq, payload: event });
      });
      connection.on('message', (message) => {
        if (message.type === 'request') void this.handleRequest(connection, message);
      });
      connection.on('close', () => {
        void runtimeDisposable.dispose();
      });
    });
    await new Promise<void>((resolve, reject) => {
      this.server?.once('error', reject);
      this.server?.listen(this.options.socketPath, resolve);
    });
  }

  async stop(): Promise<void> {
    if (!this.server) return;
    const server = this.server;
    this.server = null;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(this.options.socketPath, { force: true });
  }

  getControlState(): ReturnType<ControlLock['getState']> {
    return this.control.getState();
  }

  private async handleRequest(connection: JsonLineConnection, request: RpcRequest): Promise<void> {
    try {
      const result = await this.dispatch(request.method, request.params);
      connection.send({ type: 'response', id: request.id, result });
    } catch (error) {
      const response: RpcResponse = {
        type: 'response',
        id: request.id,
        error: {
          code: 'ERR_RPC',
          message: error instanceof Error ? error.message : String(error),
        },
      };
      connection.send(response);
    }
  }

  private async dispatch(method: string, params: unknown): Promise<unknown> {
    switch (method) {
      case 'hello':
        return this.hello(params as HelloParams);
      case 'getState':
        return this.options.runtime.getSnapshot();
      case 'attach':
        return this.attach(params as AttachParams);
      case 'detach': {
        const detachParams = params as { controllerAgentId: string; controllerPid: number };
        const state = this.control.detach(detachParams.controllerAgentId, detachParams.controllerPid);
        this.options.onControlChanged?.(state);
        return { detached: true };
      }
      case 'submit': {
        const submitParams = params as { text: string };
        return this.options.runtime.submit(submitParams.text);
      }
      case 'abort': {
        const abortParams = params as { reason?: string } | undefined;
        return this.options.runtime.abort(abortParams?.reason);
      }
      default:
        throw new Error(`Unknown RPC method: ${method}`);
    }
  }

  private hello(params: HelloParams) {
    if (params.protocol !== MICA_AGENT_RPC_PROTOCOL || params.protocolVersion !== MICA_AGENT_RPC_VERSION) {
      throw new Error('Unsupported protocol');
    }
    if (params.clientPid === process.pid) {
      throw new Error('Cannot attach to self');
    }
    return {
      agentId: this.options.agentId,
      protocolVersion: MICA_AGENT_RPC_VERSION,
      serverPid: process.pid,
    };
  }

  private attach(params: AttachParams) {
    if (params.mode === 'control') {
      const state = this.control.attach(params);
      this.options.onControlChanged?.(state);
    }
    return {
      attached: true,
      mode: params.mode,
      snapshot: this.options.runtime.getSnapshot(),
    };
  }
}
