import { connect, type Socket } from 'node:net';
import { micaCommon } from '@packages/mica-common/index.js';
import { JsonLineConnection } from './jsonLine.js';
import { MICA_AGENT_RPC_PROTOCOL, MICA_AGENT_RPC_VERSION, type AttachParams, type RpcMessage } from './protocol.js';

export class AgentIpcClient {
  private socket: Socket | null = null;
  private connection: JsonLineConnection | null = null;
  private readonly pending = new Map<string, { resolve(value: unknown): void; reject(error: unknown): void }>();
  private controllerAgentId: string | null = null;

  constructor(private readonly socketPath: string) {}

  async connect(): Promise<void> {
    this.socket = connect(this.socketPath);
    this.connection = new JsonLineConnection(this.socket);
    this.connection.on('message', (message) => this.handleMessage(message));
    this.connection.on('error', (error) => this.rejectAll(error));
    this.connection.on('close', () => this.rejectAll(new Error('IPC connection closed')));
    await new Promise<void>((resolve, reject) => {
      this.socket?.once('connect', resolve);
      this.socket?.once('error', reject);
    });
  }

  close(): void {
    this.connection?.close();
    this.connection = null;
    this.socket = null;
    this.rejectAll(new Error('IPC client closed'));
  }

  hello(clientAgentId: string) {
    this.controllerAgentId = clientAgentId;
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
    this.controllerAgentId = params.controllerAgentId;
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
    return this.request('submit', {
      text,
      ...this.controlIdentity(),
    });
  }

  abort(reason?: string) {
    return this.request('abort', {
      reason,
      ...this.controlIdentity(),
    });
  }

  private controlIdentity(): { controllerAgentId: string; controllerPid: number } {
    if (!this.controllerAgentId) {
      throw new Error('IPC client is not attached as a controller');
    }
    return {
      controllerAgentId: this.controllerAgentId,
      controllerPid: process.pid,
    };
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

  private rejectAll(error: unknown): void {
    for (const pending of this.pending.values()) {
      pending.reject(error);
    }
    this.pending.clear();
  }
}
