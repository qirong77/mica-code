import {
  deriveSessionKeys,
  deviceFingerprint,
  loadKnownMachines,
  messageAad,
  open,
  openPairAccept,
  removeKnownMachine,
  remoteStateDir,
  saveKnownMachine,
  seal,
  sealPairRequest,
  decodePairingCode,
  type KnownMachines,
} from '@packages/mica-remote-protocol/index.js';
import { randomId } from '@packages/mica-remote-protocol/ids.js';
import {
  isRemoteDirectory,
  RemoteProtocolError,
  type HistoryPage,
  type RelayFrame,
  type RemotePermission,
  type RemoteWorkspaceSummary,
  type RpcResponsePayload,
} from '@packages/mica-remote-protocol/protocol.js';
import { ensureDeviceRegistration } from './register.js';
import { RelayLink } from './relayLink.js';

export type RemoteMachineView = {
  machineId: string;
  alias: string;
  online: boolean;
  asOf: string | null;
  workspaces: RemoteWorkspaceSummary[];
  /** True when this is the relay's last known directory, not a live answer. */
  cached: boolean;
};

export type RemoteControllerOptions = {
  relay: string;
  invite?: string;
  name?: string;
  stateDir?: string;
};

type PendingPair = {
  resolve(frame: Extract<RelayFrame, { t: 'pair.accepted' }>): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
};

type PendingRpc = {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
  machineId: string;
};

type PendingRevoke = {
  resolve(): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
};

export class RemoteController {
  private readonly pendingPairs = new Map<string, PendingPair>();
  private readonly pendingRpcs = new Map<string, PendingRpc>();
  private readonly pendingRevokes = new Map<string, PendingRevoke>();
  private directoryWaiter: {
    resolve(machines: Extract<RelayFrame, { t: 'directory.state' }>['machines']): void;
    reject(error: Error): void;
    timer: ReturnType<typeof setTimeout>;
  } | null = null;
  private closed = false;

  private constructor(
    private readonly identity: { deviceId: string; privateKey: string; publicKey: string },
    private readonly link: RelayLink,
    private readonly stateDir: string,
    private readonly httpUrl: string,
    private readonly deviceName: string,
  ) {}

  static async open(options: RemoteControllerOptions): Promise<RemoteController> {
    const stateDir = options.stateDir ?? remoteStateDir();
    const registration = await ensureDeviceRegistration({
      relay: options.relay,
      invite: options.invite,
      kind: 'controller',
      name: options.name,
      stateDir,
    });
    let controller: RemoteController | null = null;
    const link = new RelayLink({
      wsUrl: registration.wsUrl,
      hello: {
        v: 1,
        t: 'hello',
        token: registration.registration.token,
        deviceId: registration.identity.deviceId,
        kind: 'controller',
        name: registration.registration.name,
        appVersion: '0.1.0',
      },
      onFrame: (frame) => controller?.handleFrame(frame),
      onClose: () => controller?.failAllPending(new Error('与中转机的连接已断开')),
    });
    controller = new RemoteController(
      registration.identity,
      link,
      stateDir,
      registration.httpUrl,
      registration.registration.name,
    );
    await withTimeout(link.connect(), 12_000, '连接中转机超时');
    return controller;
  }

  get deviceId(): string {
    return this.identity.deviceId;
  }

  async pair(code: string): Promise<KnownMachines['machines'][number]> {
    const parsed = decodePairingCode(code);
    const id = randomId('p', 9);
    const requestNonce = randomId('n', 9);
    const payload = {
      v: 1 as const,
      machineId: parsed.machineId,
      controllerId: this.identity.deviceId,
      controllerPublicKey: this.identity.publicKey,
      controllerName: this.deviceName,
      requestNonce,
    };
    const sealed = sealPairRequest(parsed.key, payload);
    const accepted = await new Promise<Extract<RelayFrame, { t: 'pair.accepted' }>>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingPairs.delete(id);
        reject(new RemoteProtocolError('offline', '配对超时：执行机可能已离线'));
      }, 20_000);
      this.pendingPairs.set(id, { resolve, reject, timer });
      if (!this.link.send({ v: 1, t: 'pair.request', id, machineId: parsed.machineId, sealed })) {
        clearTimeout(timer);
        this.pendingPairs.delete(id);
        reject(new RemoteProtocolError('offline', '尚未连接到中转机'));
      }
    });
    const acceptance = openPairAccept(parsed.key, accepted.sealed);
    if (
      acceptance.machineId !== parsed.machineId ||
      acceptance.controllerId !== this.identity.deviceId ||
      acceptance.requestNonce !== requestNonce
    ) {
      throw new RemoteProtocolError('bad_request', '配对响应与请求不匹配');
    }
    const permissions = acceptance.permissions.filter(
      (permission): permission is RemotePermission => permission === 'directory.read' || permission === 'history.read',
    );
    if (permissions.length === 0) throw new RemoteProtocolError('bad_request', '执行机没有授予任何权限');
    const machine = {
      machineId: acceptance.machineId,
      alias: acceptance.machineName,
      publicKey: acceptance.machinePublicKey,
      fingerprint: deviceFingerprint(acceptance.machinePublicKey),
      permissions,
      pairedAt: new Date().toISOString(),
    };
    saveKnownMachine(machine, this.stateDir);
    return machine;
  }

  async list(): Promise<RemoteMachineView[]> {
    const machines = await this.directoryState();
    return Promise.all(
      machines.map(async (machine) => {
        if (!machine.online) {
          return {
            machineId: machine.machineId,
            alias: machine.alias,
            online: false,
            asOf: machine.asOf,
            workspaces: machine.workspaces,
            cached: true,
          };
        }
        try {
          const live = await this.rpc(machine.machineId, 'directory.get', {}, 6000);
          if (!isRemoteDirectory(live)) throw new Error('invalid directory');
          return {
            machineId: machine.machineId,
            alias: live.machineAlias,
            online: true,
            asOf: live.asOf,
            workspaces: live.workspaces,
            cached: false,
          };
        } catch {
          return {
            machineId: machine.machineId,
            alias: machine.alias,
            online: true,
            asOf: machine.asOf,
            workspaces: machine.workspaces,
            cached: true,
          };
        }
      }),
    );
  }

  async history(
    machineId: string,
    sessionRef: string,
    options?: { cursor?: number; limit?: number },
  ): Promise<HistoryPage> {
    const machine = this.knownMachine(machineId);
    if (!machine) throw new RemoteProtocolError('not_paired', '这台机器还没有与当前设备配对');
    const result = await this.rpc(machineId, 'history.page', {
      sessionRef,
      ...(options?.cursor !== undefined ? { cursor: String(options.cursor) } : {}),
      ...(options?.limit !== undefined ? { limit: options.limit } : {}),
    });
    return validateHistoryPage(result);
  }

  async revoke(machineId: string): Promise<void> {
    if (!this.knownMachine(machineId)) {
      throw new RemoteProtocolError('not_paired', '这台机器还没有与当前设备配对');
    }
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRevokes.delete(machineId);
        reject(new RemoteProtocolError('offline', '撤销授权超时'));
      }, 10_000);
      this.pendingRevokes.set(machineId, { resolve, reject, timer });
      if (
        !this.link.send({
          v: 1,
          t: 'pair.revoke',
          machineId,
          controllerId: this.identity.deviceId,
        })
      ) {
        clearTimeout(timer);
        this.pendingRevokes.delete(machineId);
        reject(new RemoteProtocolError('offline', '尚未连接到中转机'));
      }
    });
    removeKnownMachine(machineId, this.stateDir);
  }

  async health(): Promise<{ ok: boolean; online: number; devices: number; version: string }> {
    const response = await fetch(`${this.httpUrl}/api/health`, { signal: AbortSignal.timeout(8000) });
    if (!response.ok) throw new Error(`relay health failed: ${response.status}`);
    return (await response.json()) as { ok: boolean; online: number; devices: number; version: string };
  }

  close(): void {
    this.closed = true;
    this.failAllPending(new Error('已断开'));
    this.link.close();
  }

  private knownMachine(machineId: string): KnownMachines['machines'][number] | undefined {
    return loadKnownMachines(this.stateDir).find((entry) => entry.machineId === machineId);
  }

  private directoryState(): Promise<Extract<RelayFrame, { t: 'directory.state' }>['machines']> {
    return new Promise((resolve, reject) => {
      if (this.directoryWaiter) {
        reject(new Error('目录请求尚未完成'));
        return;
      }
      const timer = setTimeout(() => {
        this.directoryWaiter = null;
        reject(new RemoteProtocolError('offline', '读取机器目录超时'));
      }, 10_000);
      this.directoryWaiter = { resolve, reject, timer };
      if (!this.link.send({ v: 1, t: 'directory.list' })) {
        clearTimeout(timer);
        this.directoryWaiter = null;
        reject(new RemoteProtocolError('offline', '尚未连接到中转机'));
      }
    });
  }

  private rpc(machineId: string, method: string, params: unknown, timeoutMs = 10_000): Promise<unknown> {
    const machine = this.knownMachine(machineId);
    if (!machine) return Promise.reject(new RemoteProtocolError('not_paired', '机器未配对'));
    const id = randomId('r', 9);
    const payload = {
      v: 1,
      method,
      params,
      requestId: id,
      sentAt: new Date().toISOString(),
    };
    const keys = deriveSessionKeys(this.identity.privateKey, machine.publicKey, this.identity.deviceId, machineId);
    const sealed = seal(
      keys.sendKey,
      JSON.stringify(payload),
      messageAad({ kind: 'rpc', from: this.identity.deviceId, to: machineId, id }),
    );
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRpcs.delete(id);
        reject(new RemoteProtocolError('offline', '请求超时，执行机可能已离线'));
      }, timeoutMs);
      this.pendingRpcs.set(id, { resolve, reject, timer, machineId });
      if (!this.link.send({ v: 1, t: 'rpc', id, to: machineId, sealed })) {
        clearTimeout(timer);
        this.pendingRpcs.delete(id);
        reject(new RemoteProtocolError('offline', '尚未连接到中转机'));
      }
    });
  }

  private handleFrame(frame: RelayFrame): void {
    if (this.closed) return;
    if (frame.t === 'pair.accepted') {
      const pending = this.pendingPairs.get(frame.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pendingPairs.delete(frame.id);
      pending.resolve(frame);
      return;
    }
    if (frame.t === 'pair.granted') {
      const known = this.knownMachine(frame.machineId);
      if (known) {
        saveKnownMachine(
          { ...known, permissions: frame.permissions, pairedAt: new Date().toISOString() },
          this.stateDir,
        );
      }
      return;
    }
    if (frame.t === 'pair.revoked') {
      const pending = this.pendingRevokes.get(frame.machineId);
      if (pending) {
        clearTimeout(pending.timer);
        this.pendingRevokes.delete(frame.machineId);
        pending.resolve();
      }
      removeKnownMachine(frame.machineId, this.stateDir);
      this.rejectMachine(frame.machineId, new RemoteProtocolError('revoked', '授权已被撤销'));
      return;
    }
    if (frame.t === 'directory.state') {
      const waiter = this.directoryWaiter;
      if (!waiter) return;
      clearTimeout(waiter.timer);
      this.directoryWaiter = null;
      waiter.resolve(frame.machines);
      return;
    }
    if (frame.t === 'rpc.result') {
      const pending = this.pendingRpcs.get(frame.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pendingRpcs.delete(frame.id);
      const machine = this.knownMachine(pending.machineId);
      if (!machine) {
        pending.reject(new RemoteProtocolError('not_paired', '机器未配对'));
        return;
      }
      try {
        const keys = deriveSessionKeys(
          this.identity.privateKey,
          machine.publicKey,
          this.identity.deviceId,
          pending.machineId,
        );
        const raw = open(
          keys.receiveKey,
          frame.sealed,
          messageAad({ kind: 'rpc.result', from: pending.machineId, to: this.identity.deviceId, id: frame.id }),
        );
        const response = JSON.parse(raw) as RpcResponsePayload;
        if (response.v !== 1 || typeof response.ok !== 'boolean') throw new Error('malformed response');
        if (response.ok) pending.resolve(response.result);
        else pending.reject(new RemoteProtocolError(response.error.code, response.error.message));
      } catch (error) {
        pending.reject(error instanceof Error ? error : new Error(String(error)));
      }
      return;
    }
    if (frame.t === 'rpc.error') {
      const pending = this.pendingRpcs.get(frame.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pendingRpcs.delete(frame.id);
      pending.reject(new RemoteProtocolError(frame.code, frame.message));
      return;
    }
    if (frame.t === 'error' && frame.requestId) {
      const pair = this.pendingPairs.get(frame.requestId);
      if (pair) {
        clearTimeout(pair.timer);
        this.pendingPairs.delete(frame.requestId);
        pair.reject(new RemoteProtocolError(frame.code, frame.message));
        return;
      }
      const rpc = this.pendingRpcs.get(frame.requestId);
      if (rpc) {
        clearTimeout(rpc.timer);
        this.pendingRpcs.delete(frame.requestId);
        rpc.reject(new RemoteProtocolError(frame.code, frame.message));
      }
    }
  }

  private rejectMachine(machineId: string, error: Error): void {
    for (const [id, pending] of this.pendingRpcs) {
      if (pending.machineId !== machineId) continue;
      clearTimeout(pending.timer);
      this.pendingRpcs.delete(id);
      pending.reject(error);
    }
  }

  private failAllPending(error: Error): void {
    for (const [id, pending] of this.pendingPairs) {
      clearTimeout(pending.timer);
      this.pendingPairs.delete(id);
      pending.reject(error);
    }
    for (const [id, pending] of this.pendingRpcs) {
      clearTimeout(pending.timer);
      this.pendingRpcs.delete(id);
      pending.reject(error);
    }
    for (const [machineId, pending] of this.pendingRevokes) {
      clearTimeout(pending.timer);
      this.pendingRevokes.delete(machineId);
      pending.reject(error);
    }
    if (this.directoryWaiter) {
      clearTimeout(this.directoryWaiter.timer);
      this.directoryWaiter.reject(error);
      this.directoryWaiter = null;
    }
  }
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function validateHistoryPage(value: unknown): HistoryPage {
  if (!value || typeof value !== 'object') throw new Error('invalid history page');
  const record = value as Record<string, unknown>;
  if (
    typeof record.sessionRef !== 'string' ||
    typeof record.revision !== 'string' ||
    !Array.isArray(record.messages) ||
    (record.nextCursor !== null && typeof record.nextCursor !== 'string') ||
    typeof record.truncated !== 'boolean'
  ) {
    throw new Error('invalid history page');
  }
  return value as HistoryPage;
}
