import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { resolveMicaHomePath } from '@packages/mica-config/brand.js';
import { createDeviceIdentity, deviceFingerprint, type DeviceIdentity } from './crypto.js';
import type { DeviceKind, RemotePermission } from './protocol.js';

export type RelayRegistration = {
  url: string;
  token: string;
  deviceId: string;
  kind: DeviceKind;
  name: string;
  registeredAt: string;
};

export type WorkspaceEntry = {
  ref: string;
  path: string;
  alias: string;
};

export type GrantEntry = {
  /** Controller device id for machine-side grants; machine id on the controller side. */
  peerId: string;
  role: 'controller' | 'machine';
  publicKey: string;
  fingerprint: string;
  name: string;
  permissions: RemotePermission[];
  pairedAt: string;
};

export type KnownMachines = {
  machines: Array<{
    machineId: string;
    alias: string;
    publicKey: string;
    fingerprint: string;
    permissions: RemotePermission[];
    pairedAt: string;
  }>;
};

export function remoteStateDir(): string {
  return resolveMicaHomePath('remote');
}

function ensureDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
}

function writeJson(path: string, value: unknown): void {
  ensureDir(dirname(path));
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  try {
    chmodSync(temp, 0o600);
  } catch {
    // best effort on filesystems without POSIX modes
  }
  renameSync(temp, path);
}

function readJson<T>(path: string): T | null {
  try {
    if (!existsSync(path)) return null;
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch {
    return null;
  }
}

export function loadOrCreateIdentity(kind: DeviceKind, dir = remoteStateDir()): DeviceIdentity {
  const path = join(dir, 'identity.json');
  const existing = readJson<DeviceIdentity>(path);
  if (existing && existing.publicKey && existing.privateKey) {
    if (existing.deviceId.startsWith(kind === 'machine' ? 'm_' : 'c_')) return existing;
    throw new Error(`remote identity at ${path} belongs to another device kind`);
  }
  const identity = createDeviceIdentity(kind);
  writeJson(path, identity);
  return identity;
}

export function loadRelayRegistration(dir = remoteStateDir()): RelayRegistration | null {
  return readJson<RelayRegistration>(join(dir, 'relay.json'));
}

export function saveRelayRegistration(registration: RelayRegistration, dir = remoteStateDir()): void {
  writeJson(join(dir, 'relay.json'), registration);
}

export function loadWorkspaces(dir = remoteStateDir()): WorkspaceEntry[] {
  return readJson<{ workspaces: WorkspaceEntry[] }>(join(dir, 'workspaces.json'))?.workspaces ?? [];
}

export function saveWorkspaces(workspaces: WorkspaceEntry[], dir = remoteStateDir()): void {
  if (workspaces.length > 32) throw new Error('too many workspaces');
  writeJson(join(dir, 'workspaces.json'), { workspaces });
}

export function loadGrants(dir = remoteStateDir()): GrantEntry[] {
  const stored = readJson<{ grants: GrantEntry[] }>(join(dir, 'grants.json'));
  return stored?.grants ?? [];
}

export function saveGrants(grants: GrantEntry[], dir = remoteStateDir()): void {
  writeJson(join(dir, 'grants.json'), { grants });
}

export function addGrant(grant: GrantEntry, dir = remoteStateDir()): GrantEntry[] {
  const grants = loadGrants(dir).filter((entry) => entry.peerId !== grant.peerId);
  grants.push(grant);
  saveGrants(grants, dir);
  return grants;
}

export function loadKnownMachines(dir = remoteStateDir()): KnownMachines['machines'] {
  return readJson<KnownMachines>(join(dir, 'known.json'))?.machines ?? [];
}

export function saveKnownMachine(
  machine: KnownMachines['machines'][number],
  dir = remoteStateDir(),
): KnownMachines['machines'] {
  const machines = loadKnownMachines(dir).filter((entry) => entry.machineId !== machine.machineId);
  machines.push(machine);
  writeJson(join(dir, 'known.json'), { machines });
  return machines;
}

export function removeKnownMachine(machineId: string, dir = remoteStateDir()): void {
  const machines = loadKnownMachines(dir).filter((entry) => entry.machineId !== machineId);
  writeJson(join(dir, 'known.json'), { machines });
}

export function clearRemoteState(dir = remoteStateDir()): void {
  rmSync(dir, { recursive: true, force: true });
}

export function grantFromController(peer: {
  controllerId: string;
  publicKey: string;
  name: string;
  permissions: RemotePermission[];
}): GrantEntry {
  return {
    peerId: peer.controllerId,
    role: 'controller',
    publicKey: peer.publicKey,
    fingerprint: deviceFingerprint(peer.publicKey),
    name: peer.name,
    permissions: peer.permissions,
    pairedAt: new Date().toISOString(),
  };
}
