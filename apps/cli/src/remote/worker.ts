import { existsSync, readFileSync, statSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { resolveMicaHomePath } from '@packages/mica-config/brand.js';
import { listSessionTurnLocks } from '@packages/mica-session/liveSessions.js';
import {
  createPairingCode,
  deriveSessionKeys,
  encodePairingCode,
  grantFromController,
  loadGrants,
  messageAad,
  open,
  openPairRequest,
  saveGrants,
  seal,
  sealPairAccept,
  type GrantEntry,
  type LocalSessionSummary,
} from '@packages/mica-remote-protocol/index.js';
import {
  buildWorkspaceSummary,
  listLocalSessions,
  loadWorkspaces,
  projectHistoryPage,
  reconcileTurnState,
  remoteStateDir,
  saveWorkspaces,
  sessionRevision,
  workspaceRefFor,
  type WorkspaceEntry,
} from '@packages/mica-remote-protocol/index.js';
import {
  parseRpcRequest,
  REMOTE_LIMITS,
  RemoteProtocolError,
  SESSION_REF_PATTERN,
  type HistoryPage,
  type RelayFrame,
  type RemoteDirectory,
  type RemotePermission,
  type RpcResponsePayload,
} from '@packages/mica-remote-protocol/index.js';
import { randomId } from '@packages/mica-remote-protocol/ids.js';
import { ensureDeviceRegistration } from './register.js';
import { RelayLink } from './relayLink.js';

const READ_PERMISSIONS: RemotePermission[] = ['directory.read', 'history.read'];

export type RemoteWorkerOptions = {
  relay: string;
  invite?: string;
  name?: string;
  workspaces: string[];
  stateDir?: string;
  sessionDir?: string;
  out?: (line: string) => void;
  signal?: AbortSignal;
};

export type RemoteWorkerHandle = {
  machineId: string;
  pairingCode: string;
  stop(): void;
};

/**
 * Machine-side worker.
 *
 * Explicitly started by `mica remote serve`; it stops when the process stops.
 * It never listens on an inbound port and only answers controllers that hold a
 * pairing grant stored on this machine.
 */
export async function startRemoteWorker(options: RemoteWorkerOptions): Promise<RemoteWorkerHandle> {
  const out = options.out ?? ((line) => process.stdout.write(`${line}\n`));
  const stateDir = options.stateDir ?? remoteStateDir();
  const sessionDir = options.sessionDir ?? resolveMicaHomePath('sessions');
  const registrationResult = await ensureDeviceRegistration({
    relay: options.relay,
    invite: options.invite,
    kind: 'machine',
    name: options.name,
    stateDir,
  });
  const { identity, registration, wsUrl } = registrationResult;
  const workspaces = resolveWorkspaces(options.workspaces, stateDir);
  if (workspaces.length === 0) {
    throw new Error('没有可远程使用的工作区：请带 --workspace <目录> 运行一次');
  }
  if (registrationResult.registered) out(`已注册执行机 ${identity.deviceId}`);
  for (const workspace of workspaces) {
    out(`工作区: ${workspace.alias} · ${workspace.ref} · ${workspace.path}`);
  }

  const pairing = createPairingCode(identity.deviceId);
  const pairingCode = encodePairingCode(pairing);
  let grants = new Map(
    loadGrants(stateDir)
      .filter((grant) => grant.role === 'controller')
      .map((grant) => [grant.peerId, grant]),
  );
  let sessionMap = new Map<string, LocalSessionSummary>();
  let lastSignature = '';
  let stopped = false;

  const buildDirectory = (): RemoteDirectory => {
    const liveSessionIds = new Set(
      listSessionTurnLocks({ sessionDir })
        .filter((lock) => lock.alive)
        .map((lock) => lock.sessionId),
    );
    const sessions = listLocalSessions(sessionDir).map((session) =>
      reconcileTurnState(session, liveSessionIds),
    );
    const nextSessionMap = new Map<string, LocalSessionSummary>();
    const summaries = workspaces.slice(0, REMOTE_LIMITS.maxWorkspacesPerMachine).map((workspace) => {
      const built = buildWorkspaceSummary({
        workspacePath: workspace.path,
        alias: workspace.alias,
        sessions,
      });
      for (const [ref, session] of built.sessionMap) nextSessionMap.set(ref, session);
      return built.summary;
    });
    sessionMap = nextSessionMap;
    return {
      machineId: identity.deviceId,
      machineAlias: registration.name,
      asOf: new Date().toISOString(),
      workspaces: summaries,
    };
  };

  const link = new RelayLink({
    wsUrl,
    hello: {
      v: 1,
      t: 'hello',
      token: registration.token,
      deviceId: identity.deviceId,
      kind: 'machine',
      name: registration.name,
      appVersion: '0.1.0',
    },
    onFrame: (frame) => {
      handleFrame(frame);
    },
    onClose: () => {
      out('与中转机的连接已断开，正在重试…');
    },
  });

  const publishDirectory = (force = false): void => {
    const directory = buildDirectory();
    if (!link.connected) return;
    const signature = JSON.stringify({ alias: directory.machineAlias, workspaces: directory.workspaces });
    if (!force && signature === lastSignature) return;
    lastSignature = signature;
    link.send({ v: 1, t: 'directory.publish', machineId: identity.deviceId, directory });
  };

  const handleFrame = (frame: RelayFrame): void => {
    if (frame.t === 'hello.ok') {
      lastSignature = '';
      publishDirectory(true);
      out('已连接中转机，目录已发布');
      return;
    }
    if (frame.t === 'pair.incoming') {
      handlePairIncoming(frame);
      return;
    }
    if (frame.t === 'rpc') {
      handleRpc(frame);
      return;
    }
    if (frame.t === 'pair.revoked') {
      if (frame.machineId === identity.deviceId) {
        grants.delete(frame.controllerId);
        saveGrants([...grants.values()], stateDir);
        out(`授权已撤销: ${frame.controllerId}`);
      }
      return;
    }
    if (frame.t === 'pair.granted' && frame.machineId === identity.deviceId) {
      out(`配对成功: ${frame.controllerId}`);
    }
  };

  function handlePairIncoming(frame: Extract<RelayFrame, { t: 'pair.incoming' }>): void {
    let payload;
    try {
      payload = openPairRequest(pairing.key, frame.sealed);
    } catch {
      out(`忽略无法解密的配对请求: ${frame.from}`);
      return;
    }
    if (payload.machineId !== identity.deviceId || payload.controllerId !== frame.from) {
      out(`忽略不匹配的配对请求: ${frame.from}`);
      return;
    }
    const grant = grantFromController({
      controllerId: payload.controllerId,
      publicKey: payload.controllerPublicKey,
      name: payload.controllerName,
      permissions: READ_PERMISSIONS,
    });
    grants.set(grant.peerId, grant);
    saveGrants([...grants.values()], stateDir);

    const acceptance = sealPairAccept(pairing.key, {
      v: 1,
      machineId: identity.deviceId,
      machinePublicKey: identity.publicKey,
      machineName: registration.name,
      controllerId: payload.controllerId,
      requestNonce: payload.requestNonce,
      grantId: randomId('g', 9),
      permissions: READ_PERMISSIONS,
    });
    link.send({
      v: 1,
      t: 'pair.grant',
      machineId: identity.deviceId,
      controllerId: payload.controllerId,
      permissions: READ_PERMISSIONS,
    });
    link.send({ v: 1, t: 'pair.accept', id: frame.id, to: payload.controllerId, sealed: acceptance });
    out(`已配对控制端: ${payload.controllerName} (${payload.controllerId})`);
  }

  function handleRpc(frame: Extract<RelayFrame, { t: 'rpc' }>): void {
    const fromId = frame.from;
    if (!fromId) return;
    const grant = grants.get(fromId);
    if (!grant) {
      link.send({
        v: 1,
        t: 'rpc.error',
        id: frame.id,
        to: fromId,
        code: 'not_paired',
        message: '这台执行机没有该控制端的授权',
      });
      return;
    }
    const keys = deriveSessionKeys(identity.privateKey, grant.publicKey, identity.deviceId, grant.peerId);
    let response: RpcResponsePayload;
    try {
      const request = parseRpcRequest(
        open(
          keys.receiveKey,
          frame.sealed,
          messageAad({
            kind: 'rpc',
            from: fromId,
            to: identity.deviceId,
            id: frame.id,
          }),
        ),
      );
      if (request.requestId !== frame.id) throw new RemoteProtocolError('bad_request', '请求标识不匹配');
      response = { v: 1, ok: true, result: dispatch(request.method, request.params, grant) };
    } catch (error) {
      const protocol = error instanceof RemoteProtocolError ? error : null;
      response = {
        v: 1,
        ok: false,
        error: {
          code: protocol?.code ?? 'internal',
          message: protocol?.message ?? '执行机处理失败',
        },
      };
    }
    const sealed = seal(
      keys.sendKey,
      JSON.stringify(response),
      messageAad({ kind: 'rpc.result', from: identity.deviceId, to: fromId, id: frame.id }),
    );
    link.send({ v: 1, t: 'rpc.result', id: frame.id, to: fromId, sealed });
  }

  function dispatch(method: string, params: unknown, grant: GrantEntry): unknown {
    if (method === 'ping') return { pong: true, at: new Date().toISOString() };
    if (method === 'directory.get') {
      if (!grant.permissions.includes('directory.read')) {
        throw new RemoteProtocolError('unauthorized', '没有读取目录的授权');
      }
      return buildDirectory();
    }
    if (method === 'history.page') {
      if (!grant.permissions.includes('history.read')) {
        throw new RemoteProtocolError('unauthorized', '没有读取历史的授权');
      }
      return readHistoryPage(params);
    }
    throw new RemoteProtocolError('unknown_method', `不支持的方法: ${method}`);
  }

  function readHistoryPage(params: unknown): HistoryPage {
    const record = params && typeof params === 'object' ? (params as Record<string, unknown>) : null;
    const sessionRef = record?.sessionRef;
    if (typeof sessionRef !== 'string' || !SESSION_REF_PATTERN.test(sessionRef)) {
      throw new RemoteProtocolError('bad_request', 'sessionRef 格式不正确');
    }
    const session = sessionMap.get(sessionRef);
    if (!session) throw new RemoteProtocolError('not_found', '这条会话不在已授权的工作区里');
    const stat = statSync(session.path);
    if (stat.size > REMOTE_LIMITS.maxSessionFileBytes) {
      throw new RemoteProtocolError('session_too_large', '会话文件超过读取上限，请在本机查看');
    }
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(session.path, 'utf8'));
    } catch {
      throw new RemoteProtocolError('internal', '读取会话失败');
    }
    const cursor = typeof record?.cursor === 'string' ? Number(record.cursor) : undefined;
    const limit = typeof record?.limit === 'number' ? record.limit : undefined;
    return projectHistoryPage({
      raw,
      sessionRef,
      revision: sessionRevision(stat, session.sessionId),
      ...(Number.isFinite(cursor) && cursor! >= 0 ? { cursor: Math.trunc(cursor!) } : {}),
      ...(limit ? { limit } : {}),
    });
  }

  const publishTimer = setInterval(() => publishDirectory(false), 10_000);
  publishTimer.unref?.();

  const handleAbort = () => {
    if (stopped) return;
    stopped = true;
    clearInterval(publishTimer);
    link.close();
  };
  options.signal?.addEventListener('abort', handleAbort, { once: true });

  out(`执行机: ${identity.deviceId} (${registration.name})`);
  out(`中转机: ${wsUrl}`);
  out('配对码（本次运行有效，重启后会换新）:');
  out(`  ${pairingCode}`);
  out('在控制端执行: mica remote pair <配对码>');
  void link.connect().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    out(`连接中转机失败，将自动重试: ${message}`);
  });

  return {
    machineId: identity.deviceId,
    pairingCode,
    stop: handleAbort,
  };
}

function resolveWorkspaces(paths: string[], stateDir: string): WorkspaceEntry[] {
  const saved = loadWorkspaces(stateDir);
  const byPath = new Map(saved.map((workspace) => [resolve(workspace.path), workspace]));
  for (const input of paths) {
    const path = resolve(input);
    if (!existsSync(path) || !statSync(path).isDirectory()) {
      throw new Error(`工作区不存在或不是目录: ${path}`);
    }
    byPath.set(path, {
      ref: workspaceRefFor(path),
      path,
      alias: basename(path) || path,
    });
  }
  const workspaces = [...byPath.values()].slice(0, REMOTE_LIMITS.maxWorkspacesPerMachine);
  if (workspaces.length > 0) saveWorkspaces(workspaces, stateDir);
  return workspaces;
}
