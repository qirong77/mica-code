import { connect, type Socket } from 'node:net';
import { micaCommon } from '@packages/mica-common/index.js';
import { JsonLineConnection } from './jsonLine.js';
import { MICA_AGENT_RPC_PROTOCOL, MICA_AGENT_RPC_VERSION, type AttachParams, type RpcMessage } from './protocol.js';

export class AgentIpcClient {
  private socket: Socket | null = null;
  private connection: JsonLineConnection | null = null;
  private readonly pending = new Map<string, { resolve(value: unknown): void; reject(error: unknown): void }>();

  constructor(private readonly socketPath: string) {}

  async connect(): Promise<void> {
    this.socket = connect(this.socketPath);
    this.connection = new JsonLineConnection(this.socket);
    this.connection.on('message', (message) => this.handleMessage(message));
    await new Promise<void>((resolve, reject) => {
      this.socket?.once('connect', resolve);
      this.socket?.once('error', reject);
    });
  }

  close(): void {
    this.connection?.close();
    this.connection = null;
    this.socket = null;
  }

  hello(clientAgentId: string) {
    return this.request('hello', {
      protocol: MICA_AGENT_RPC_PROTOCOL,
      protocolVersion: MICA_AGENT_RPC_VERSION,
      clientAgentId,
      clientPid: process.pid,
      clientCwd: process.cwd(),
    });
  }

  getState() {
    return this.request('getState');
  }

  attach(params: Omit<AttachParams, 'controllerPid' | 'controllerCwd'>) {
    return this.request('attach', {
      ...params,
      controllerPid: process.pid,
      controllerCwd: process.cwd(),
    });
  }

  detach(controllerAgentId: string) {
    return this.request('detach', {
      controllerAgentId,
      controllerPid: process.pid,
    });
  }

  submit(text: string) {
    return this.request('submit', { text });
  }

  abort(reason?: string) {
    return this.request('abort', { reason });
  }

  private request(method: string, params?: unknown): Promise<unknown> {
    if (!this.connection) throw new Error('IPC client is not connected');
    const id = micaCommon.createId('rpc');
    this.connection.send({ type: 'request', id, method, params });
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });
  }

  private handleMessage(message: RpcMessage): void {
    if (message.type !== 'response') return;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    if (message.error) {
      pending.reject(new Error(message.error.message));
      return;
    }
    pending.resolve(message.result);
  }
}
