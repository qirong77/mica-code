import { timingSafeEqual } from 'node:crypto';
import { DEVICE_ID_PATTERN, randomToken, sha256Base64Url } from '@packages/mica-remote-protocol/ids.js';
import { REMOTE_LIMITS, utf8Bytes } from '@packages/mica-remote-protocol/limits.js';
import {
  parseRelayFrame,
  RemoteProtocolError,
  REMOTE_PROTOCOL_VERSION,
  type DeviceKind,
  type RegisterDeviceRequest,
  type RegisterDeviceResponse,
  type RelayFrame,
  type RemoteErrorCode,
  type RemotePermission,
} from '@packages/mica-remote-protocol/protocol.js';
import type { RelayPairing, RelayStore } from './store.js';

export type RelaySocket = {
  send(text: string): void;
  close(code?: number, reason?: string): void;
};

type Connection = {
  id: string;
  socket: RelaySocket;
  deviceId?: string;
  kind?: DeviceKind;
  name?: string;
  authed: boolean;
  closed: boolean;
  rateTokens: number;
  rateUpdatedAt: number;
  inFlight: number;
  lastSeenAt: number;
  pendingRpcs: Set<string>;
};

export type RelayConnectionHandle = {
  id: string;
  receive(raw: string): void;
  close(): void;
};

const CLOSE_REPLACED = 4001;
const CLOSE_STALE = 4002;
const CLOSE_POLICY = 1008;

function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left, 'utf8');
  const b = Buffer.from(right, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function validPermissionList(value: RemotePermission[]): boolean {
  const allowed = new Set<RemotePermission>(['directory.read', 'history.read']);
  return value.length > 0 && value.every((item) => allowed.has(item));
}

/**
 * Transport-free relay logic.
 *
 * It knows device ids, pairing grants, presence and directory metadata, and it
 * forwards sealed envelopes. It never opens a payload and never stores one.
 */
export class RelayService {
  private readonly connections = new Map<string, Connection>();
  private readonly pendingPairs = new Map<string, { machineId: string; controllerId: string; at: number }>();
  private sequence = 0;

  constructor(
    private readonly store: RelayStore,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  get inviteCode(): string {
    return this.store.snapshot.inviteCode;
  }

  get onlineCount(): number {
    return [...this.connections.values()].filter((conn) => conn.authed).length;
  }

  registerDevice(input: RegisterDeviceRequest): RegisterDeviceResponse {
    const state = this.store.snapshot;
    if (!safeEqual(input.inviteCode.trim(), state.inviteCode)) {
      throw new RemoteProtocolError('unauthorized', '邀请码无效');
    }
    if (!DEVICE_ID_PATTERN.test(input.deviceId)) {
      throw new RemoteProtocolError('bad_request', '设备标识格式不正确');
    }
    if (input.kind === 'machine' && !input.deviceId.startsWith('m_')) {
      throw new RemoteProtocolError('bad_request', '执行机标识必须以 m_ 开头');
    }
    if (input.kind === 'controller' && !input.deviceId.startsWith('c_')) {
      throw new RemoteProtocolError('bad_request', '控制端标识必须以 c_ 开头');
    }
    if (!input.publicKey || utf8Bytes(input.publicKey) > 512) {
      throw new RemoteProtocolError('bad_request', '公钥格式不正确');
    }
    const name = input.name.trim().slice(0, REMOTE_LIMITS.maxPairingNameChars) || '未命名设备';
    const existing = state.devices[input.deviceId];
    if (existing && existing.publicKey !== input.publicKey) {
      throw new RemoteProtocolError('conflict', '该设备标识已被另一把密钥使用');
    }
    if (!existing && Object.keys(state.devices).length >= REMOTE_LIMITS.maxMachinesPerRelay * 8) {
      throw new RemoteProtocolError('conflict', '中转机设备数量已达上限');
    }
    const token = randomToken();
    this.store.mutate((draft) => {
      draft.devices[input.deviceId] = {
        deviceId: input.deviceId,
        kind: input.kind,
        name,
        publicKey: input.publicKey,
        tokenHash: sha256Base64Url(token),
        createdAt: existing?.createdAt ?? this.clock().toISOString(),
        appVersion: input.appVersion,
      };
    });
    return {
      ok: true,
      deviceId: input.deviceId,
      token,
      serverTime: this.clock().toISOString(),
    };
  }

  attach(socket: RelaySocket): RelayConnectionHandle {
    this.sequence += 1;
    const connection: Connection = {
      id: `conn_${this.sequence}`,
      socket,
      authed: false,
      closed: false,
      rateTokens: REMOTE_LIMITS.rateBurst,
      rateUpdatedAt: this.clock().getTime(),
      inFlight: 0,
      lastSeenAt: this.clock().getTime(),
      pendingRpcs: new Set(),
    };
    return {
      id: connection.id,
      receive: (raw) => this.receive(connection, raw),
      close: () => this.dropConnection(connection),
    };
  }

  private receive(connection: Connection, raw: string): void {
    if (connection.closed) return;
    connection.lastSeenAt = this.clock().getTime();
    let frame: RelayFrame;
    try {
      frame = parseRelayFrame(raw);
    } catch (error) {
      const protocol = error instanceof RemoteProtocolError ? error : null;
      this.sendError(connection, protocol?.code ?? 'bad_request', protocol?.message ?? '无法解析的请求');
      if (!connection.authed) this.close(connection, CLOSE_POLICY, 'handshake failed');
      return;
    }
    try {
      this.dispatch(connection, frame);
    } catch (error) {
      const protocol = error instanceof RemoteProtocolError ? error : null;
      const requestId = 'id' in frame && typeof frame.id === 'string' ? frame.id : undefined;
      this.sendError(connection, protocol?.code ?? 'internal', protocol?.message ?? '中转机处理失败', requestId);
      if (!connection.authed) this.close(connection, CLOSE_POLICY, 'handshake failed');
    }
  }

  private dispatch(connection: Connection, frame: RelayFrame): void {
    if (frame.t === 'hello') {
      this.handleHello(connection, frame);
      return;
    }
    if (!connection.authed || !connection.deviceId || !connection.kind) {
      throw new RemoteProtocolError('unauthorized', '请先完成设备认证');
    }
    switch (frame.t) {
      case 'ping':
        this.send(connection, { v: 1, t: 'pong', at: this.clock().toISOString() });
        return;
      case 'pair.request':
        this.handlePairRequest(connection, frame);
        return;
      case 'pair.accept':
        this.handlePairAccept(connection, frame);
        return;
      case 'pair.grant':
        this.handlePairGrant(connection, frame);
        return;
      case 'pair.revoke':
        this.handlePairRevoke(connection, frame);
        return;
      case 'rpc':
      case 'rpc.result':
      case 'rpc.error':
        this.handleRpc(connection, frame);
        return;
      case 'directory.publish':
        this.handleDirectoryPublish(connection, frame);
        return;
      case 'directory.list':
        this.handleDirectoryList(connection);
        return;
      case 'pong':
        return;
      default:
        throw new RemoteProtocolError('bad_request', `不支持的帧类型: ${frame.t}`);
    }
  }

  private handleHello(connection: Connection, frame: Extract<RelayFrame, { t: 'hello' }>): void {
    if (connection.authed) throw new RemoteProtocolError('conflict', '该连接已完成认证');
    const device = this.store.snapshot.devices[frame.deviceId];
    if (!device || device.revokedAt) throw new RemoteProtocolError('unauthorized', '设备未注册或已撤销');
    if (device.kind !== frame.kind) throw new RemoteProtocolError('unauthorized', '设备类型不匹配');
    if (!safeEqual(sha256Base64Url(frame.token), device.tokenHash)) {
      throw new RemoteProtocolError('unauthorized', '设备口令无效');
    }
    const previous = this.connections.get(device.deviceId);
    if (previous && previous !== connection) this.close(previous, CLOSE_REPLACED, 'replaced by a newer connection');

    connection.deviceId = device.deviceId;
    connection.kind = device.kind;
    connection.name = device.name;
    connection.authed = true;
    connection.rateUpdatedAt = this.clock().getTime();
    connection.rateTokens = REMOTE_LIMITS.rateBurst;
    this.connections.set(device.deviceId, connection);
    this.store.mutate((draft) => {
      const stored = draft.devices[device.deviceId];
      if (stored) stored.lastSeenAt = this.clock().toISOString();
    });

    const peers = this.activePairingsFor(device.deviceId).map((pairing) =>
      device.deviceId === pairing.machineId ? pairing.controllerId : pairing.machineId,
    );
    this.send(connection, {
      v: REMOTE_PROTOCOL_VERSION,
      t: 'hello.ok',
      serverTime: this.clock().toISOString(),
      deviceId: device.deviceId,
      pairings: peers,
    });

    if (device.kind === 'machine') {
      this.broadcastPresence(device.deviceId, true);
    } else {
      for (const machineId of peers) {
        this.send(connection, {
          v: 1,
          t: 'presence',
          machineId,
          online: this.isOnline(machineId),
          at: this.clock().toISOString(),
        });
      }
    }
  }

  private handlePairRequest(connection: Connection, frame: Extract<RelayFrame, { t: 'pair.request' }>): void {
    if (connection.kind !== 'controller') throw new RemoteProtocolError('unauthorized', '只有控制端可以发起配对');
    const machine = this.store.snapshot.devices[frame.machineId];
    if (!machine || machine.kind !== 'machine') throw new RemoteProtocolError('not_found', '执行机不存在');
    if (!this.isOnline(frame.machineId)) throw new RemoteProtocolError('offline', '执行机当前离线');
    const key = `${frame.machineId}|${connection.deviceId!}|${frame.id}`;
    this.pendingPairs.set(key, {
      machineId: frame.machineId,
      controllerId: connection.deviceId!,
      at: this.clock().getTime(),
    });
    this.sendToDevice(frame.machineId, {
      v: 1,
      t: 'pair.incoming',
      id: frame.id,
      from: connection.deviceId!,
      sealed: frame.sealed,
    });
  }

  private handlePairAccept(connection: Connection, frame: Extract<RelayFrame, { t: 'pair.accept' }>): void {
    if (connection.kind !== 'machine') throw new RemoteProtocolError('unauthorized', '只有执行机可以确认配对');
    const key = `${connection.deviceId!}|${frame.to}|${frame.id}`;
    if (!this.pendingPairs.has(key)) throw new RemoteProtocolError('not_found', '没有待确认的配对请求');
    this.pendingPairs.delete(key);
    this.sendToDevice(frame.to, {
      v: 1,
      t: 'pair.accepted',
      id: frame.id,
      from: connection.deviceId!,
      sealed: frame.sealed,
    });
  }

  private handlePairGrant(connection: Connection, frame: Extract<RelayFrame, { t: 'pair.grant' }>): void {
    if (connection.kind !== 'machine') throw new RemoteProtocolError('unauthorized', '只有执行机可以登记授权');
    if (frame.machineId !== connection.deviceId)
      throw new RemoteProtocolError('unauthorized', '不能为其他机器登记授权');
    const controller = this.store.snapshot.devices[frame.controllerId];
    if (!controller || controller.kind !== 'controller') throw new RemoteProtocolError('not_found', '控制端不存在');
    if (!validPermissionList(frame.permissions)) throw new RemoteProtocolError('bad_request', '授权范围无效');
    this.store.mutate((draft) => {
      const existing = draft.pairings.find(
        (pairing) => pairing.machineId === frame.machineId && pairing.controllerId === frame.controllerId,
      );
      if (existing) {
        existing.permissions = frame.permissions;
        delete existing.revokedAt;
      } else {
        draft.pairings.push({
          machineId: frame.machineId,
          controllerId: frame.controllerId,
          permissions: frame.permissions,
          createdAt: this.clock().toISOString(),
        });
      }
    });
    const granted = {
      v: REMOTE_PROTOCOL_VERSION,
      t: 'pair.granted' as const,
      machineId: frame.machineId,
      controllerId: frame.controllerId,
      permissions: frame.permissions,
    };
    this.sendToDevice(frame.controllerId, granted);
    this.sendToDevice(frame.machineId, granted);
  }

  private handlePairRevoke(connection: Connection, frame: Extract<RelayFrame, { t: 'pair.revoke' }>): void {
    if (connection.deviceId !== frame.machineId && connection.deviceId !== frame.controllerId) {
      throw new RemoteProtocolError('unauthorized', '无权撤销这组授权');
    }
    this.store.mutate((draft) => {
      const pairing = draft.pairings.find(
        (item) => item.machineId === frame.machineId && item.controllerId === frame.controllerId,
      );
      if (pairing) pairing.revokedAt = this.clock().toISOString();
    });
    const revoked = {
      v: REMOTE_PROTOCOL_VERSION,
      t: 'pair.revoked' as const,
      machineId: frame.machineId,
      controllerId: frame.controllerId,
    };
    this.sendToDevice(frame.machineId, revoked);
    this.sendToDevice(frame.controllerId, revoked);
  }

  private handleRpc(
    connection: Connection,
    frame: Extract<RelayFrame, { t: 'rpc' | 'rpc.result' | 'rpc.error' }>,
  ): void {
    const from = connection.deviceId!;
    const pairing = this.activePairingBetween(from, frame.to);
    if (!pairing) throw new RemoteProtocolError('not_paired', '两台设备之间没有有效授权');
    const target = this.connections.get(frame.to);
    if (!target || !target.authed) {
      if (frame.t === 'rpc') {
        this.send(connection, {
          v: 1,
          t: 'rpc.error',
          id: frame.id,
          to: from,
          code: 'offline',
          message: '目标设备当前离线',
        });
      }
      return;
    }
    if (frame.t === 'rpc') {
      if (!this.consumeRate(connection)) {
        this.send(connection, {
          v: 1,
          t: 'rpc.error',
          id: frame.id,
          to: from,
          code: 'rate_limited',
          message: '请求过于频繁',
        });
        return;
      }
      if (connection.kind === 'controller' && connection.inFlight >= REMOTE_LIMITS.maxConcurrentReads) {
        this.send(connection, {
          v: 1,
          t: 'rpc.error',
          id: frame.id,
          to: from,
          code: 'rate_limited',
          message: '并发读取请求过多',
        });
        return;
      }
      if (utf8Bytes(frame.sealed.c) > REMOTE_LIMITS.maxFrameBytes) {
        throw new RemoteProtocolError('payload_too_large', '请求体超过上限');
      }
      connection.pendingRpcs.add(frame.id);
      connection.inFlight += 1;
    } else {
      const requester = this.connections.get(frame.to);
      if (requester?.pendingRpcs.delete(frame.id)) {
        requester.inFlight = Math.max(0, requester.inFlight - 1);
      }
    }
    this.send(target, { ...frame, from });
  }

  private handleDirectoryPublish(connection: Connection, frame: Extract<RelayFrame, { t: 'directory.publish' }>): void {
    if (connection.kind !== 'machine') throw new RemoteProtocolError('unauthorized', '只有执行机可以发布目录');
    if (frame.machineId !== connection.deviceId)
      throw new RemoteProtocolError('unauthorized', '不能发布其他机器的目录');
    this.store.mutate((draft) => {
      draft.directories[frame.machineId] = frame.directory;
    });
    for (const pairing of this.activePairingsFor(frame.machineId)) {
      if (pairing.controllerId === frame.machineId) continue;
      this.sendToDevice(pairing.controllerId, {
        v: 1,
        t: 'directory.updated',
        machineId: frame.machineId,
        asOf: frame.directory.asOf,
      });
    }
  }

  private handleDirectoryList(connection: Connection): void {
    if (connection.kind !== 'controller') throw new RemoteProtocolError('unauthorized', '只有控制端可以读取目录');
    const state = this.store.snapshot;
    const machines = this.activePairingsFor(connection.deviceId!)
      .filter((pairing) => pairing.controllerId === connection.deviceId)
      .map((pairing) => {
        const device = state.devices[pairing.machineId];
        const directory = state.directories[pairing.machineId];
        return {
          machineId: pairing.machineId,
          alias: device?.name ?? directory?.machineAlias ?? '未命名执行机',
          online: this.isOnline(pairing.machineId),
          asOf: directory?.asOf ?? null,
          workspaces: directory?.workspaces ?? [],
        };
      });
    this.send(connection, { v: 1, t: 'directory.state', machines });
  }

  private consumeRate(connection: Connection): boolean {
    const now = this.clock().getTime();
    const elapsed = Math.max(0, now - connection.rateUpdatedAt);
    connection.rateTokens = Math.min(
      REMOTE_LIMITS.rateBurst,
      connection.rateTokens + (elapsed / 1000) * REMOTE_LIMITS.ratePerSecond,
    );
    connection.rateUpdatedAt = now;
    if (connection.rateTokens < 1) return false;
    connection.rateTokens -= 1;
    return true;
  }

  sweepInactive(): void {
    const now = this.clock().getTime();
    for (const connection of this.connections.values()) {
      if (now - connection.lastSeenAt > REMOTE_LIMITS.presenceTimeoutMs) {
        this.close(connection, CLOSE_STALE, 'heartbeat timeout');
      }
    }
  }

  private activePairingsFor(deviceId: string): RelayPairing[] {
    return this.store.snapshot.pairings.filter(
      (pairing) => !pairing.revokedAt && (pairing.machineId === deviceId || pairing.controllerId === deviceId),
    );
  }

  private activePairingBetween(left: string, right: string): RelayPairing | undefined {
    return this.store.snapshot.pairings.find(
      (pairing) =>
        !pairing.revokedAt &&
        ((pairing.machineId === left && pairing.controllerId === right) ||
          (pairing.machineId === right && pairing.controllerId === left)),
    );
  }

  private isOnline(deviceId: string): boolean {
    const connection = this.connections.get(deviceId);
    return Boolean(connection?.authed && !connection.closed);
  }

  private sendToDevice(deviceId: string, frame: RelayFrame): void {
    const connection = this.connections.get(deviceId);
    if (connection && !connection.closed) this.send(connection, frame);
  }

  private send(connection: Connection, frame: RelayFrame): void {
    if (connection.closed) return;
    try {
      connection.socket.send(JSON.stringify(frame));
    } catch {
      this.dropConnection(connection);
    }
  }

  private sendError(connection: Connection, code: RemoteErrorCode, message: string, requestId?: string): void {
    this.send(connection, {
      v: 1,
      t: 'error',
      code,
      message,
      ...(requestId ? { requestId } : {}),
    });
  }

  private close(connection: Connection, code: number, reason: string): void {
    if (connection.closed) return;
    connection.closed = true;
    try {
      connection.socket.close(code, reason);
    } catch {
      // ignore: the transport may already be gone
    }
    this.dropConnection(connection);
  }

  private dropConnection(connection: Connection): void {
    if (!connection.deviceId) {
      connection.closed = true;
      return;
    }
    if (this.connections.get(connection.deviceId) === connection) {
      this.connections.delete(connection.deviceId);
      if (connection.kind === 'machine') this.broadcastPresence(connection.deviceId, false);
    }
    connection.closed = true;
    for (const [key, pending] of this.pendingPairs) {
      if (pending.machineId === connection.deviceId || pending.controllerId === connection.deviceId) {
        this.pendingPairs.delete(key);
      }
    }
  }

  private broadcastPresence(machineId: string, online: boolean): void {
    const at = this.clock().toISOString();
    for (const pairing of this.activePairingsFor(machineId)) {
      if (pairing.controllerId === machineId) continue;
      this.sendToDevice(pairing.controllerId, { v: 1, t: 'presence', machineId, online, at });
    }
  }
}
