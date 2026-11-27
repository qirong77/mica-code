import { DEVICE_ID_PATTERN, WORKSPACE_REF_PATTERN, SESSION_REF_PATTERN } from './ids.js';
import { REMOTE_LIMITS, utf8Bytes } from './limits.js';

export const REMOTE_PROTOCOL_VERSION = 1 as const;
export const REMOTE_APP_VERSION = '0.1.0';

export type DeviceKind = 'machine' | 'controller';

export type RemoteErrorCode =
  | 'bad_request'
  | 'unauthorized'
  | 'not_paired'
  | 'revoked'
  | 'offline'
  | 'rate_limited'
  | 'payload_too_large'
  | 'unknown_method'
  | 'not_found'
  | 'session_too_large'
  | 'conflict'
  | 'internal';

export class RemoteProtocolError extends Error {
  readonly code: RemoteErrorCode;
  constructor(code: RemoteErrorCode, message: string) {
    super(message);
    this.name = 'RemoteProtocolError';
    this.code = code;
  }
}

export type RemotePermission = 'directory.read' | 'history.read';

export const REMOTE_PERMISSIONS: readonly RemotePermission[] = ['directory.read', 'history.read'];

export type RemoteSessionSummary = {
  sessionRef: string;
  /** Only a manually named session's title is safe to publish. */
  alias?: string;
  updatedAt: string;
  turnState: string;
};

export type RemoteWorkspaceSummary = {
  workspaceRef: string;
  alias: string;
  sessions: RemoteSessionSummary[];
};

export type RemoteDirectory = {
  machineId: string;
  machineAlias: string;
  asOf: string;
  workspaces: RemoteWorkspaceSummary[];
};

export type HistoryMessage = {
  role: 'user' | 'assistant';
  text: string;
  at?: string;
  truncated?: boolean;
};

export type HistoryPage = {
  sessionRef: string;
  revision: string;
  messages: HistoryMessage[];
  /** Number of older messages already delivered; null means no older page. */
  nextCursor: string | null;
  truncated: boolean;
  source: 'live';
  asOf: string;
};

export type RemoteRpcMethod = 'directory.get' | 'history.page' | 'ping';

export type RpcRequestPayload = {
  v: 1;
  method: RemoteRpcMethod;
  params: unknown;
  requestId: string;
  sentAt: string;
};

export type RpcResponsePayload =
  | { v: 1; ok: true; result: unknown }
  | { v: 1; ok: false; error: { code: RemoteErrorCode; message: string } };

export type SealedEnvelope = { n: string; c: string };

/* ------------------------------------------------------------------ relay */

export type RelayHelloFrame = {
  v: 1;
  t: 'hello';
  token: string;
  deviceId: string;
  kind: DeviceKind;
  name: string;
  appVersion: string;
};

export type RelayFrame =
  | RelayHelloFrame
  | {
      v: 1;
      t: 'hello.ok';
      serverTime: string;
      deviceId: string;
      pairings: string[];
    }
  | { v: 1; t: 'error'; code: RemoteErrorCode; message: string; requestId?: string }
  | { v: 1; t: 'pair.request'; id: string; machineId: string; sealed: SealedEnvelope }
  | { v: 1; t: 'pair.incoming'; id: string; from: string; sealed: SealedEnvelope }
  | { v: 1; t: 'pair.accepted'; id: string; from: string; sealed: SealedEnvelope }
  | { v: 1; t: 'pair.accept'; id: string; to: string; sealed: SealedEnvelope }
  | {
      v: 1;
      t: 'pair.grant';
      machineId: string;
      controllerId: string;
      permissions: RemotePermission[];
    }
  | {
      v: 1;
      t: 'pair.granted';
      machineId: string;
      controllerId: string;
      permissions: RemotePermission[];
    }
  | { v: 1; t: 'pair.revoke'; machineId: string; controllerId: string }
  | { v: 1; t: 'pair.revoked'; machineId: string; controllerId: string }
  | { v: 1; t: 'rpc'; id: string; to: string; from?: string; sealed: SealedEnvelope }
  | { v: 1; t: 'rpc.result'; id: string; to: string; from?: string; sealed: SealedEnvelope }
  | {
      v: 1;
      t: 'rpc.error';
      id: string;
      to: string;
      from?: string;
      code: RemoteErrorCode;
      message: string;
    }
  | { v: 1; t: 'directory.publish'; machineId: string; directory: RemoteDirectory }
  | { v: 1; t: 'directory.updated'; machineId: string; asOf: string }
  | { v: 1; t: 'directory.list' }
  | {
      v: 1;
      t: 'directory.state';
      machines: Array<{
        machineId: string;
        alias: string;
        online: boolean;
        asOf: string | null;
        workspaces: RemoteWorkspaceSummary[];
      }>;
    }
  | { v: 1; t: 'presence'; machineId: string; online: boolean; at: string }
  | { v: 1; t: 'ping'; at: string }
  | { v: 1; t: 'pong'; at: string };

export type RegisterDeviceRequest = {
  inviteCode: string;
  deviceId: string;
  kind: DeviceKind;
  publicKey: string;
  name: string;
  appVersion: string;
};

export type RegisterDeviceResponse = {
  ok: true;
  deviceId: string;
  token: string;
  serverTime: string;
};

/* ------------------------------------------------------------- validation */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isString(value: unknown, max = 4096): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max;
}

function isSealed(value: unknown): value is SealedEnvelope {
  return (
    isRecord(value) &&
    typeof value.n === 'string' &&
    value.n.length > 0 &&
    value.n.length <= 64 &&
    typeof value.c === 'string' &&
    value.c.length > 0 &&
    value.c.length <= REMOTE_LIMITS.maxFrameBytes
  );
}

function isPermissionList(value: unknown): value is RemotePermission[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((item) => typeof item === 'string' && (REMOTE_PERMISSIONS as readonly string[]).includes(item))
  );
}

function isSessionSummary(value: unknown): value is RemoteSessionSummary {
  if (!isRecord(value)) return false;
  return (
    typeof value.sessionRef === 'string' &&
    SESSION_REF_PATTERN.test(value.sessionRef) &&
    (value.alias === undefined || typeof value.alias === 'string') &&
    typeof value.updatedAt === 'string' &&
    typeof value.turnState === 'string'
  );
}

export function isWorkspaceSummary(value: unknown): value is RemoteWorkspaceSummary {
  if (!isRecord(value)) return false;
  return (
    typeof value.workspaceRef === 'string' &&
    WORKSPACE_REF_PATTERN.test(value.workspaceRef) &&
    typeof value.alias === 'string' &&
    value.alias.length <= 120 &&
    Array.isArray(value.sessions) &&
    value.sessions.length <= REMOTE_LIMITS.maxSessionsPerWorkspace &&
    value.sessions.every(isSessionSummary)
  );
}

export function isRemoteDirectory(value: unknown): value is RemoteDirectory {
  if (!isRecord(value)) return false;
  return (
    typeof value.machineId === 'string' &&
    DEVICE_ID_PATTERN.test(value.machineId) &&
    value.machineId.startsWith('m_') &&
    typeof value.machineAlias === 'string' &&
    value.machineAlias.length <= 120 &&
    typeof value.asOf === 'string' &&
    Array.isArray(value.workspaces) &&
    value.workspaces.length <= REMOTE_LIMITS.maxWorkspacesPerMachine &&
    value.workspaces.every(isWorkspaceSummary)
  );
}

export function parseRelayFrame(raw: string): RelayFrame {
  if (utf8Bytes(raw) > REMOTE_LIMITS.maxFrameBytes) {
    throw new RemoteProtocolError('payload_too_large', 'frame exceeds the size limit');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new RemoteProtocolError('bad_request', 'frame is not JSON');
  }
  if (!isRecord(parsed) || parsed.v !== 1 || typeof parsed.t !== 'string') {
    throw new RemoteProtocolError('bad_request', 'unsupported frame');
  }
  const type = parsed.t;
  switch (type) {
    case 'hello':
      if (
        !isString(parsed.token, 512) ||
        typeof parsed.deviceId !== 'string' ||
        !DEVICE_ID_PATTERN.test(parsed.deviceId) ||
        (parsed.kind !== 'machine' && parsed.kind !== 'controller') ||
        !isString(parsed.name, 120) ||
        typeof parsed.appVersion !== 'string'
      ) {
        throw new RemoteProtocolError('bad_request', 'malformed hello');
      }
      return parsed as RelayFrame;
    case 'hello.ok':
      return parsed as RelayFrame;
    case 'error':
      if (typeof parsed.code !== 'string' || typeof parsed.message !== 'string') {
        throw new RemoteProtocolError('bad_request', 'malformed error frame');
      }
      return parsed as RelayFrame;
    case 'pair.request':
    case 'pair.incoming':
    case 'pair.accepted':
    case 'pair.accept': {
      const id = parsed.id;
      const sealed = parsed.sealed;
      if (!isString(id, 128) || !isSealed(sealed)) {
        throw new RemoteProtocolError('bad_request', 'malformed pairing frame');
      }
      const target = type === 'pair.request' ? parsed.machineId : type === 'pair.accept' ? parsed.to : parsed.from;
      if (typeof target !== 'string' || !DEVICE_ID_PATTERN.test(target)) {
        throw new RemoteProtocolError('bad_request', 'malformed pairing target');
      }
      if (utf8Bytes(raw) > REMOTE_LIMITS.maxPairingBytes) {
        throw new RemoteProtocolError('payload_too_large', 'pairing payload exceeds the size limit');
      }
      return parsed as RelayFrame;
    }
    case 'pair.grant':
    case 'pair.granted':
      if (
        typeof parsed.machineId !== 'string' ||
        !DEVICE_ID_PATTERN.test(parsed.machineId) ||
        typeof parsed.controllerId !== 'string' ||
        !DEVICE_ID_PATTERN.test(parsed.controllerId) ||
        !isPermissionList(parsed.permissions)
      ) {
        throw new RemoteProtocolError('bad_request', 'malformed grant frame');
      }
      return parsed as RelayFrame;
    case 'pair.revoke':
    case 'pair.revoked':
      if (
        typeof parsed.machineId !== 'string' ||
        !DEVICE_ID_PATTERN.test(parsed.machineId) ||
        typeof parsed.controllerId !== 'string' ||
        !DEVICE_ID_PATTERN.test(parsed.controllerId)
      ) {
        throw new RemoteProtocolError('bad_request', 'malformed revoke frame');
      }
      return parsed as RelayFrame;
    case 'rpc':
    case 'rpc.result': {
      if (!isString(parsed.id, 128) || typeof parsed.to !== 'string' || !DEVICE_ID_PATTERN.test(parsed.to)) {
        throw new RemoteProtocolError('bad_request', 'malformed rpc frame');
      }
      if (!isSealed(parsed.sealed)) throw new RemoteProtocolError('bad_request', 'malformed rpc payload');
      return parsed as RelayFrame;
    }
    case 'rpc.error':
      if (!isString(parsed.id, 128) || typeof parsed.to !== 'string' || typeof parsed.message !== 'string') {
        throw new RemoteProtocolError('bad_request', 'malformed rpc error');
      }
      return parsed as RelayFrame;
    case 'directory.publish':
      if (!isRemoteDirectory(parsed.directory) || parsed.directory.machineId !== parsed.machineId) {
        throw new RemoteProtocolError('bad_request', 'malformed directory');
      }
      if (utf8Bytes(raw) > REMOTE_LIMITS.maxDirectoryBytes) {
        throw new RemoteProtocolError('payload_too_large', 'directory exceeds the size limit');
      }
      return parsed as RelayFrame;
    case 'directory.updated':
      if (typeof parsed.machineId !== 'string' || typeof parsed.asOf !== 'string') {
        throw new RemoteProtocolError('bad_request', 'malformed directory update');
      }
      return parsed as RelayFrame;
    case 'directory.list':
      return parsed as RelayFrame;
    case 'directory.state':
      return parsed as RelayFrame;
    case 'presence':
      if (typeof parsed.machineId !== 'string' || typeof parsed.online !== 'boolean' || typeof parsed.at !== 'string') {
        throw new RemoteProtocolError('bad_request', 'malformed presence frame');
      }
      return parsed as RelayFrame;
    case 'ping':
    case 'pong':
      if (typeof parsed.at !== 'string') throw new RemoteProtocolError('bad_request', 'malformed ping');
      return parsed as RelayFrame;
    default:
      throw new RemoteProtocolError('bad_request', `unknown frame type: ${type}`);
  }
}

export function parseRpcRequest(payload: string): RpcRequestPayload {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    throw new RemoteProtocolError('bad_request', 'rpc payload is not JSON');
  }
  if (!isRecord(parsed) || parsed.v !== 1) throw new RemoteProtocolError('bad_request', 'unsupported rpc payload');
  const method = parsed.method;
  if (method !== 'directory.get' && method !== 'history.page' && method !== 'ping') {
    throw new RemoteProtocolError('unknown_method', 'unknown rpc method');
  }
  if (!isString(parsed.requestId, 128) || typeof parsed.sentAt !== 'string') {
    throw new RemoteProtocolError('bad_request', 'malformed rpc payload');
  }
  return parsed as RpcRequestPayload;
}
