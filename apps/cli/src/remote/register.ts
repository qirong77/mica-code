import { hostname } from 'node:os';
import {
  loadOrCreateIdentity,
  loadRelayRegistration,
  remoteStateDir,
  saveRelayRegistration,
  type RelayRegistration,
} from '@packages/mica-remote-protocol/localState.js';
import type { DeviceIdentity } from '@packages/mica-remote-protocol/crypto.js';
import { REMOTE_APP_VERSION } from '@packages/mica-remote-protocol/protocol.js';
import type { DeviceKind } from '@packages/mica-remote-protocol/protocol.js';
import { normalizeRelayUrl } from './relayUrl.js';

export type RegistrationOptions = {
  relay: string;
  invite?: string;
  kind: DeviceKind;
  name?: string;
  stateDir?: string;
};

export type RegistrationResult = {
  identity: DeviceIdentity;
  registration: RelayRegistration;
  wsUrl: string;
  httpUrl: string;
  /** True when this run registered the device instead of reusing a stored token. */
  registered: boolean;
};

export async function ensureDeviceRegistration(options: RegistrationOptions): Promise<RegistrationResult> {
  const stateDir = options.stateDir ?? remoteStateDir();
  const identity = loadOrCreateIdentity(options.kind, stateDir);
  const { wsUrl, httpUrl } = normalizeRelayUrl(options.relay);
  const existing = loadRelayRegistration(stateDir);
  if (existing && existing.deviceId === identity.deviceId && existing.url === httpUrl) {
    return { identity, registration: existing, wsUrl, httpUrl, registered: false };
  }
  if (!options.invite) {
    throw new Error(`这台设备还没有注册到 ${httpUrl}：请带 --invite <邀请码> 运行一次（邀请码在 relay 启动时打印）`);
  }
  const name = (options.name?.trim() || hostname()).slice(0, 80);
  const response = await fetch(`${httpUrl}/api/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      inviteCode: options.invite,
      deviceId: identity.deviceId,
      kind: options.kind,
      publicKey: identity.publicKey,
      name,
      appVersion: REMOTE_APP_VERSION,
    }),
    signal: AbortSignal.timeout(10_000),
  });
  const body = (await response.json().catch(() => null)) as {
    ok?: boolean;
    token?: string;
    deviceId?: string;
    error?: string;
  } | null;
  if (!response.ok || !body?.ok || typeof body.token !== 'string' || body.deviceId !== identity.deviceId) {
    throw new Error(`注册失败：${body?.error ?? response.statusText}`);
  }
  const registration: RelayRegistration = {
    url: httpUrl,
    token: body.token,
    deviceId: identity.deviceId,
    kind: options.kind,
    name,
    registeredAt: new Date().toISOString(),
  };
  saveRelayRegistration(registration, stateDir);
  return { identity, registration, wsUrl, httpUrl, registered: true };
}
