import {
  createCipheriv,
  createDecipheriv,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
} from 'node:crypto';
import { base32Decode, base32Encode, fingerprintOf, groupChars, randomId } from './ids.js';

const SESSION_INFO_PREFIX = 'mica-remote-v1';
const PAIRING_INFO = 'mica-remote-pair-v1';
const PAIRING_CODE_PREFIX = 'MICA1';
const MACHINE_ID_CHARS = 17;

export type DeviceIdentity = {
  deviceId: string;
  publicKey: string;
  privateKey: string;
  createdAt: string;
};

export type SessionKeys = {
  sendKey: Uint8Array;
  receiveKey: Uint8Array;
};

export type SealedMessage = {
  /** base64url AES-GCM nonce. */
  n: string;
  /** base64url ciphertext with the GCM tag appended. */
  c: string;
};

export type PairingCode = {
  machineId: string;
  secret: Uint8Array;
  key: Uint8Array;
};

export function createDeviceIdentity(kind: 'machine' | 'controller'): DeviceIdentity {
  const { publicKey, privateKey } = generateKeyPairSync('x25519');
  return {
    deviceId: randomId(kind === 'machine' ? 'm' : 'c'),
    publicKey: publicKey.export({ type: 'spki', format: 'der' }).toString('base64url'),
    privateKey: privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64url'),
    createdAt: new Date().toISOString(),
  };
}

export function deviceFingerprint(publicKey: string): string {
  return fingerprintOf(publicKey);
}

/**
 * X25519 + HKDF. The two directions get distinct keys so a ciphertext cannot be
 * reflected back to its sender.
 */
export function deriveSessionKeys(
  selfPrivateKey: string,
  peerPublicKey: string,
  selfDeviceId: string,
  peerDeviceId: string,
): SessionKeys {
  const privateKey = createPrivateKey({
    key: Buffer.from(selfPrivateKey, 'base64url'),
    format: 'der',
    type: 'pkcs8',
  });
  const publicKey = createPublicKey({
    key: Buffer.from(peerPublicKey, 'base64url'),
    format: 'der',
    type: 'spki',
  });
  const shared = diffieHellman({ privateKey, publicKey });
  const [low, high] = [selfDeviceId, peerDeviceId].sort();
  if (!low || !high) throw new Error('device ids are required for key derivation');
  const salt = Buffer.from(`${low}|${high}`, 'utf8');
  const forward = Buffer.from(hkdfSync('sha256', shared, salt, `${SESSION_INFO_PREFIX}|${low}->${high}`, 32));
  const backward = Buffer.from(hkdfSync('sha256', shared, salt, `${SESSION_INFO_PREFIX}|${high}->${low}`, 32));
  return selfDeviceId === low
    ? { sendKey: new Uint8Array(forward), receiveKey: new Uint8Array(backward) }
    : { sendKey: new Uint8Array(backward), receiveKey: new Uint8Array(forward) };
}

export function seal(key: Uint8Array, plaintext: string, aad: string): SealedMessage {
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(Buffer.from(aad, 'utf8'));
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final(), cipher.getAuthTag()]);
  return {
    n: nonce.toString('base64url'),
    c: ciphertext.toString('base64url'),
  };
}

export function open(key: Uint8Array, sealed: SealedMessage, aad: string): string {
  const nonce = Buffer.from(sealed.n, 'base64url');
  const payload = Buffer.from(sealed.c, 'base64url');
  if (nonce.length !== 12 || payload.length < 16) throw new Error('malformed sealed message');
  const tag = payload.subarray(payload.length - 16);
  const body = payload.subarray(0, payload.length - 16);
  const decipher = createDecipheriv('aes-256-gcm', key, nonce);
  decipher.setAAD(Buffer.from(aad, 'utf8'));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8');
}

/** Message AAD binds sender, receiver, purpose and correlation id. */
export function messageAad(args: { kind: string; from: string; to: string; id: string }): string {
  return [SESSION_INFO_PREFIX, args.kind, args.from, args.to, args.id].join('|');
}

function pairingKey(secret: Uint8Array): Uint8Array {
  return new Uint8Array(hkdfSync('sha256', secret, Buffer.from(PAIRING_CODE_PREFIX), PAIRING_INFO, 32));
}

/**
 * A fresh 128-bit secret is generated for every `mica remote serve` run. The
 * pairing code carries the machine id plus that secret; the relay never sees
 * either in plaintext.
 */
export function createPairingCode(machineId: string): PairingCode {
  if (machineId.length !== MACHINE_ID_CHARS) throw new Error('unexpected machine id length');
  const secret = randomBytes(16);
  return { machineId, secret, key: pairingKey(secret) };
}

export function encodePairingCode(code: PairingCode): string {
  const secret = groupChars(base32Encode(code.secret).toUpperCase(), 5);
  return `${PAIRING_CODE_PREFIX}-${code.machineId.toUpperCase()}-${secret}`;
}

export function decodePairingCode(input: string): PairingCode {
  const cleaned = input.trim().toUpperCase().replace(/[\s-]/g, '');
  if (!cleaned.startsWith(PAIRING_CODE_PREFIX)) throw new Error('pairing code is not a MICA1 code');
  const body = cleaned.slice(PAIRING_CODE_PREFIX.length);
  const machineId = body.slice(0, MACHINE_ID_CHARS).toLowerCase();
  const secretText = body.slice(MACHINE_ID_CHARS);
  if (!machineId.startsWith('m_') || secretText.length !== 26) throw new Error('malformed pairing code');
  const secret = base32Decode(secretText);
  if (secret.length !== 16) throw new Error('malformed pairing code');
  return { machineId, secret, key: pairingKey(secret) };
}

export type PairRequestPayload = {
  v: 1;
  machineId: string;
  controllerId: string;
  controllerPublicKey: string;
  controllerName: string;
  requestNonce: string;
};

export type PairAcceptPayload = {
  v: 1;
  machineId: string;
  machinePublicKey: string;
  machineName: string;
  controllerId: string;
  requestNonce: string;
  grantId: string;
  permissions: string[];
};

export function sealPairRequest(key: Uint8Array, payload: PairRequestPayload): SealedMessage {
  return seal(key, JSON.stringify(payload), `${PAIRING_INFO}|request`);
}

export function openPairRequest(key: Uint8Array, sealed: SealedMessage): PairRequestPayload {
  const parsed: unknown = JSON.parse(open(key, sealed, `${PAIRING_INFO}|request`));
  if (!isPairRequestPayload(parsed)) throw new Error('malformed pairing request');
  return parsed;
}

export function sealPairAccept(key: Uint8Array, payload: PairAcceptPayload): SealedMessage {
  return seal(key, JSON.stringify(payload), `${PAIRING_INFO}|accept`);
}

export function openPairAccept(key: Uint8Array, sealed: SealedMessage): PairAcceptPayload {
  const parsed: unknown = JSON.parse(open(key, sealed, `${PAIRING_INFO}|accept`));
  if (!isPairAcceptPayload(parsed)) throw new Error('malformed pairing acceptance');
  return parsed;
}

function isPairRequestPayload(value: unknown): value is PairRequestPayload {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return (
    record.v === 1 &&
    typeof record.machineId === 'string' &&
    typeof record.controllerId === 'string' &&
    typeof record.controllerPublicKey === 'string' &&
    typeof record.controllerName === 'string' &&
    typeof record.requestNonce === 'string'
  );
}

function isPairAcceptPayload(value: unknown): value is PairAcceptPayload {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return (
    record.v === 1 &&
    typeof record.machineId === 'string' &&
    typeof record.machinePublicKey === 'string' &&
    typeof record.machineName === 'string' &&
    typeof record.controllerId === 'string' &&
    typeof record.requestNonce === 'string' &&
    typeof record.grantId === 'string' &&
    Array.isArray(record.permissions) &&
    record.permissions.every((item) => typeof item === 'string')
  );
}
