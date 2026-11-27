import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomToken } from '@packages/mica-remote-protocol/ids.js';
import type { DeviceKind, RemoteDirectory, RemotePermission } from '@packages/mica-remote-protocol/protocol.js';

export type RelayDevice = {
  deviceId: string;
  kind: DeviceKind;
  name: string;
  publicKey: string;
  tokenHash: string;
  createdAt: string;
  lastSeenAt?: string;
  revokedAt?: string;
  appVersion?: string;
};

export type RelayPairing = {
  machineId: string;
  controllerId: string;
  permissions: RemotePermission[];
  createdAt: string;
  revokedAt?: string;
};

export type RelayState = {
  version: 1;
  inviteCode: string;
  createdAt: string;
  devices: Record<string, RelayDevice>;
  pairings: RelayPairing[];
  directories: Record<string, RemoteDirectory>;
};

export function createRelayState(now = new Date()): RelayState {
  return {
    version: 1,
    inviteCode: `MICA-${randomToken(18)}`,
    createdAt: now.toISOString(),
    devices: {},
    pairings: [],
    directories: {},
  };
}

/**
 * Relay persistence is deliberately small: device records, pairing grants, and
 * the latest published directory. Message bodies are never written here.
 */
export class RelayStore {
  private state: RelayState;
  private readonly filePath: string | null;

  constructor(filePath: string | null, initial?: RelayState) {
    this.filePath = filePath;
    if (initial) {
      this.state = initial;
    } else if (filePath && existsSync(filePath)) {
      this.state = normalizeState(JSON.parse(readFileSync(filePath, 'utf8')) as RelayState);
    } else {
      this.state = createRelayState();
      this.save();
    }
  }

  get snapshot(): RelayState {
    return this.state;
  }

  mutate(change: (state: RelayState) => void): void {
    change(this.state);
    this.save();
  }

  save(): void {
    if (!this.filePath) return;
    mkdirSync(dirname(this.filePath), { recursive: true });
    const temp = `${this.filePath}.${process.pid}.tmp`;
    writeFileSync(temp, `${JSON.stringify(this.state, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    renameSync(temp, this.filePath);
  }
}

function normalizeState(state: RelayState): RelayState {
  if (state.version !== 1 || typeof state.inviteCode !== 'string') throw new Error('unsupported relay data');
  return {
    version: 1,
    inviteCode: state.inviteCode,
    createdAt: state.createdAt ?? new Date().toISOString(),
    devices: state.devices ?? {},
    pairings: state.pairings ?? [],
    directories: state.directories ?? {},
  };
}
