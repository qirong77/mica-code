import { describe, expect, it } from 'vitest';
import {
  createDeviceIdentity,
  opaqueRef,
  randomId,
  workspaceRefFor,
  type RelayFrame,
} from '@packages/mica-remote-protocol/index.js';
import { RelayService } from './relay.js';
import { createRelayState, RelayStore, type RelayState } from './store.js';

class FakeSocket {
  frames: RelayFrame[] = [];
  closed = false;

  send(text: string): void {
    this.frames.push(JSON.parse(text) as RelayFrame);
  }

  close(): void {
    this.closed = true;
  }

  last<T extends RelayFrame['t']>(type: T): Extract<RelayFrame, { t: T }> | undefined {
    for (let index = this.frames.length - 1; index >= 0; index--) {
      const frame = this.frames[index]!;
      if (frame.t === type) return frame as Extract<RelayFrame, { t: T }>;
    }
    return undefined;
  }

  all<T extends RelayFrame['t']>(type: T): Array<Extract<RelayFrame, { t: T }>> {
    return this.frames.filter((frame): frame is Extract<RelayFrame, { t: T }> => frame.t === type);
  }

  clear(): void {
    this.frames = [];
  }
}

type Harness = {
  store: RelayStore;
  service: RelayService;
  state: RelayState;
  machine: ReturnType<typeof createDeviceIdentity>;
  controller: ReturnType<typeof createDeviceIdentity>;
  machineToken: string;
  controllerToken: string;
};

type Paired = Harness & {
  machineSocket: FakeSocket;
  controllerSocket: FakeSocket;
  machineConn: ReturnType<RelayService['attach']>;
  controllerConn: ReturnType<RelayService['attach']>;
};

function harness(): Harness {
  const state = createRelayState(new Date('2026-11-27T00:00:00Z'));
  const store = new RelayStore(null, state);
  const service = new RelayService(store);
  const machine = createDeviceIdentity('machine');
  const controller = createDeviceIdentity('controller');
  const machineToken = service.registerDevice({
    inviteCode: state.inviteCode,
    deviceId: machine.deviceId,
    kind: 'machine',
    publicKey: machine.publicKey,
    name: '家里的 Mac',
    appVersion: 'test',
  }).token;
  const controllerToken = service.registerDevice({
    inviteCode: state.inviteCode,
    deviceId: controller.deviceId,
    kind: 'controller',
    publicKey: controller.publicKey,
    name: '公司电脑',
    appVersion: 'test',
  }).token;
  return { store, service, state, machine, controller, machineToken, controllerToken };
}

function hello(
  service: RelayService,
  socket: FakeSocket,
  deviceId: string,
  kind: 'machine' | 'controller',
  token: string,
): ReturnType<RelayService['attach']> {
  const conn = service.attach(socket);
  conn.receive(
    JSON.stringify({
      v: 1,
      t: 'hello',
      token,
      deviceId,
      kind,
      name: kind === 'machine' ? '家里的 Mac' : '公司电脑',
      appVersion: 'test',
    }),
  );
  return conn;
}

function paired(): Paired {
  const h = harness();
  const machineSocket = new FakeSocket();
  const controllerSocket = new FakeSocket();
  const machineConn = hello(h.service, machineSocket, h.machine.deviceId, 'machine', h.machineToken);
  const controllerConn = hello(h.service, controllerSocket, h.controller.deviceId, 'controller', h.controllerToken);
  const requestId = randomId('p', 6);
  controllerConn.receive(
    JSON.stringify({
      v: 1,
      t: 'pair.request',
      id: requestId,
      machineId: h.machine.deviceId,
      sealed: { n: 'AAAAAAAAAAAAAAAA', c: 'sealed-pair-request' },
    }),
  );
  machineConn.receive(
    JSON.stringify({
      v: 1,
      t: 'pair.grant',
      machineId: h.machine.deviceId,
      controllerId: h.controller.deviceId,
      permissions: ['directory.read', 'history.read'],
    }),
  );
  machineConn.receive(
    JSON.stringify({
      v: 1,
      t: 'pair.accept',
      id: requestId,
      to: h.controller.deviceId,
      sealed: { n: 'AAAAAAAAAAAAAAAA', c: 'sealed-pair-accept' },
    }),
  );
  return { ...h, machineSocket, controllerSocket, machineConn, controllerConn };
}

function directoryFor(machineId: string) {
  return {
    machineId,
    machineAlias: '家里的 Mac',
    asOf: '2026-11-27T00:00:10.000Z',
    workspaces: [
      {
        workspaceRef: workspaceRefFor('/work/demo'),
        alias: 'demo',
        sessions: [
          {
            sessionRef: opaqueRef('session', 's1'),
            alias: '手动命名的会话',
            updatedAt: '2026-11-27T00:00:09.000Z',
            turnState: 'completed',
          },
        ],
      },
    ],
  };
}

describe('relay', () => {
  it('registers only devices holding the invite code', () => {
    const h = harness();
    expect(() =>
      h.service.registerDevice({
        inviteCode: 'wrong',
        deviceId: 'm_aaaaaaaaaaaaaaa',
        kind: 'machine',
        publicKey: 'x',
        name: 'x',
        appVersion: 'test',
      }),
    ).toThrow(/邀请码/);

    const socket = new FakeSocket();
    hello(h.service, socket, h.machine.deviceId, 'machine', 'wrong-token');
    expect(socket.last('error')?.code).toBe('unauthorized');
    expect(socket.closed).toBe(true);
  });

  it('routes pairing only to an online machine and records the grant', () => {
    const p = paired();
    expect(p.machineSocket.last('pair.incoming')?.from).toBe(p.controller.deviceId);
    expect(p.controllerSocket.last('pair.accepted')?.from).toBe(p.machine.deviceId);
    expect(p.controllerSocket.last('pair.granted')?.permissions).toEqual(['directory.read', 'history.read']);

    const pairing = p.store.snapshot.pairings.find(
      (entry) => entry.machineId === p.machine.deviceId && entry.controllerId === p.controller.deviceId,
    );
    expect(pairing?.revokedAt).toBeUndefined();
    expect(JSON.stringify(p.store.snapshot)).not.toContain('sealed-pair-request');
    expect(JSON.stringify(p.store.snapshot)).not.toContain('sealed-pair-accept');
  });

  it('reports an offline machine instead of a stale success', () => {
    const h = harness();
    const controllerSocket = new FakeSocket();
    const controllerConn = hello(h.service, controllerSocket, h.controller.deviceId, 'controller', h.controllerToken);
    controllerConn.receive(
      JSON.stringify({
        v: 1,
        t: 'pair.request',
        id: 'p1',
        machineId: h.machine.deviceId,
        sealed: { n: 'AAAAAAAAAAAAAAAA', c: 'x' },
      }),
    );
    const error = controllerSocket.last('error');
    expect(error?.code).toBe('offline');
    expect(error?.requestId).toBe('p1');
  });

  it('publishes directory metadata and keeps the last copy when the machine goes offline', () => {
    const p = paired();
    p.machineConn.receive(
      JSON.stringify({
        v: 1,
        t: 'directory.publish',
        machineId: p.machine.deviceId,
        directory: directoryFor(p.machine.deviceId),
      }),
    );
    p.controllerSocket.clear();
    p.controllerConn.receive(JSON.stringify({ v: 1, t: 'directory.list' }));
    const online = p.controllerSocket.last('directory.state');
    expect(online?.machines[0]?.online).toBe(true);
    expect(online?.machines[0]?.workspaces[0]?.sessions[0]?.alias).toBe('手动命名的会话');

    p.machineConn.close();
    p.controllerSocket.clear();
    p.controllerConn.receive(JSON.stringify({ v: 1, t: 'directory.list' }));
    const offline = p.controllerSocket.last('directory.state');
    expect(offline?.machines[0]?.online).toBe(false);
    expect(offline?.machines[0]?.workspaces[0]?.workspaceRef).toBe(workspaceRefFor('/work/demo'));
  });

  it('forwards sealed rpc frames and returns offline errors', () => {
    const p = paired();
    p.machineSocket.clear();
    p.controllerSocket.clear();

    p.controllerConn.receive(
      JSON.stringify({
        v: 1,
        t: 'rpc',
        id: 'r1',
        to: p.machine.deviceId,
        sealed: { n: 'AAAAAAAAAAAAAAAA', c: 'opaque' },
      }),
    );
    const forwarded = p.machineSocket.last('rpc');
    expect(forwarded?.from).toBe(p.controller.deviceId);
    expect(forwarded?.sealed.c).toBe('opaque');
    p.machineConn.receive(
      JSON.stringify({
        v: 1,
        t: 'rpc.result',
        id: 'r1',
        to: p.controller.deviceId,
        sealed: { n: 'AAAAAAAAAAAAAAAA', c: 'opaque-result' },
      }),
    );
    expect(p.controllerSocket.last('rpc.result')?.from).toBe(p.machine.deviceId);

    p.machineConn.close();
    p.controllerSocket.clear();
    p.controllerConn.receive(
      JSON.stringify({
        v: 1,
        t: 'rpc',
        id: 'r2',
        to: p.machine.deviceId,
        sealed: { n: 'AAAAAAAAAAAAAAAA', c: 'x' },
      }),
    );
    expect(p.controllerSocket.last('rpc.error')?.code).toBe('offline');
  });

  it('stops routing after a revoke', () => {
    const p = paired();
    p.controllerSocket.clear();
    p.machineConn.receive(
      JSON.stringify({
        v: 1,
        t: 'pair.revoke',
        machineId: p.machine.deviceId,
        controllerId: p.controller.deviceId,
      }),
    );
    expect(p.controllerSocket.last('pair.revoked')?.machineId).toBe(p.machine.deviceId);
    p.controllerSocket.clear();
    p.controllerConn.receive(
      JSON.stringify({
        v: 1,
        t: 'rpc',
        id: 'r1',
        to: p.machine.deviceId,
        sealed: { n: 'AAAAAAAAAAAAAAAA', c: 'x' },
      }),
    );
    expect(p.controllerSocket.last('error')?.code).toBe('not_paired');
  });

  it('limits concurrent reads and request rate', () => {
    const p = paired();
    p.controllerSocket.clear();

    for (let index = 0; index < 5; index++) {
      p.controllerConn.receive(
        JSON.stringify({
          v: 1,
          t: 'rpc',
          id: `c${index}`,
          to: p.machine.deviceId,
          sealed: { n: 'AAAAAAAAAAAAAAAA', c: 'x' },
        }),
      );
    }
    expect(p.controllerSocket.all('rpc.error').some((frame) => frame.code === 'rate_limited')).toBe(true);

    for (let index = 0; index < 4; index++) {
      p.machineConn.receive(
        JSON.stringify({
          v: 1,
          t: 'rpc.result',
          id: `c${index}`,
          to: p.controller.deviceId,
          sealed: { n: 'AAAAAAAAAAAAAAAA', c: 'x' },
        }),
      );
    }
    p.controllerSocket.clear();
    for (let index = 0; index < 25; index++) {
      const id = `d${index}`;
      p.controllerConn.receive(
        JSON.stringify({
          v: 1,
          t: 'rpc',
          id,
          to: p.machine.deviceId,
          sealed: { n: 'AAAAAAAAAAAAAAAA', c: 'x' },
        }),
      );
      p.machineConn.receive(
        JSON.stringify({
          v: 1,
          t: 'rpc.result',
          id,
          to: p.controller.deviceId,
          sealed: { n: 'AAAAAAAAAAAAAAAA', c: 'x' },
        }),
      );
    }
    expect(p.controllerSocket.all('rpc.error').some((frame) => frame.code === 'rate_limited')).toBe(true);
  });
});
