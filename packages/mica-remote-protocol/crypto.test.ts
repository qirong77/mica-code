import { describe, expect, it } from 'vitest';
import {
  createDeviceIdentity,
  createPairingCode,
  decodePairingCode,
  deriveSessionKeys,
  deviceFingerprint,
  encodePairingCode,
  messageAad,
  open,
  openPairAccept,
  openPairRequest,
  seal,
  sealPairAccept,
  sealPairRequest,
} from './index.js';

describe('device identity', () => {
  it('creates x25519 identities with a stable fingerprint', () => {
    const machine = createDeviceIdentity('machine');
    const controller = createDeviceIdentity('controller');
    expect(machine.deviceId.startsWith('m_')).toBe(true);
    expect(controller.deviceId.startsWith('c_')).toBe(true);
    expect(deviceFingerprint(machine.publicKey)).toMatch(/^[A-Z2-7]{4}(-[A-Z2-7]{4})+$/);
    expect(deviceFingerprint(machine.publicKey)).not.toBe(deviceFingerprint(controller.publicKey));
  });
});

describe('session keys', () => {
  it('derives opposite directions for both peers', () => {
    const machine = createDeviceIdentity('machine');
    const controller = createDeviceIdentity('controller');
    const fromMachine = deriveSessionKeys(
      machine.privateKey,
      controller.publicKey,
      machine.deviceId,
      controller.deviceId,
    );
    const fromController = deriveSessionKeys(
      controller.privateKey,
      machine.publicKey,
      controller.deviceId,
      machine.deviceId,
    );
    expect(Buffer.from(fromMachine.sendKey).equals(Buffer.from(fromController.receiveKey))).toBe(true);
    expect(Buffer.from(fromMachine.receiveKey).equals(Buffer.from(fromController.sendKey))).toBe(true);
    expect(Buffer.from(fromMachine.sendKey).equals(Buffer.from(fromMachine.receiveKey))).toBe(false);
  });

  it('seals and opens with sender/receiver binding', () => {
    const machine = createDeviceIdentity('machine');
    const controller = createDeviceIdentity('controller');
    const keys = deriveSessionKeys(machine.privateKey, controller.publicKey, machine.deviceId, controller.deviceId);
    const peerKeys = deriveSessionKeys(controller.privateKey, machine.publicKey, controller.deviceId, machine.deviceId);
    const aad = messageAad({ kind: 'rpc', from: controller.deviceId, to: machine.deviceId, id: 'r1' });
    const sealed = seal(keys.sendKey, JSON.stringify({ hello: 'world' }), aad);
    expect(open(peerKeys.receiveKey, sealed, aad)).toBe('{"hello":"world"}');
    expect(() => open(peerKeys.receiveKey, sealed, `${aad}|tampered`)).toThrow();
    const tampered = { ...sealed, c: `${sealed.c.slice(0, -2)}AA` };
    expect(() => open(peerKeys.receiveKey, tampered, aad)).toThrow();
  });
});

describe('pairing code', () => {
  it('round-trips machine id and secret', () => {
    const machine = createDeviceIdentity('machine');
    const code = createPairingCode(machine.deviceId);
    const encoded = encodePairingCode(code);
    expect(encoded.startsWith('MICA1-')).toBe(true);
    const decoded = decodePairingCode(encoded);
    expect(decoded.machineId).toBe(machine.deviceId);
    expect(Buffer.from(decoded.secret).equals(Buffer.from(code.secret))).toBe(true);
    expect(Buffer.from(decoded.key).equals(Buffer.from(code.key))).toBe(true);
  });

  it('rejects malformed codes', () => {
    expect(() => decodePairingCode('nope')).toThrow();
    expect(() => decodePairingCode('MICA1-M_ABC-123')).toThrow();
  });

  it('keeps pairing payloads confidential and bound to the code', () => {
    const machine = createDeviceIdentity('machine');
    const controller = createDeviceIdentity('controller');
    const code = createPairingCode(machine.deviceId);
    const request = {
      v: 1 as const,
      machineId: machine.deviceId,
      controllerId: controller.deviceId,
      controllerPublicKey: controller.publicKey,
      controllerName: '公司电脑',
      requestNonce: 'nonce-1',
    };
    const sealed = sealPairRequest(code.key, request);
    expect(sealed.c).not.toContain(controller.publicKey);
    expect(openPairRequest(code.key, sealed)).toEqual(request);
    const acceptance = {
      v: 1 as const,
      machineId: machine.deviceId,
      machinePublicKey: machine.publicKey,
      machineName: '家里的 Mac',
      controllerId: controller.deviceId,
      requestNonce: request.requestNonce,
      grantId: 'g1',
      permissions: ['directory.read', 'history.read'],
    };
    const sealedAccept = sealPairAccept(code.key, acceptance);
    expect(openPairAccept(code.key, sealedAccept)).toEqual(acceptance);
    expect(() => openPairAccept(createPairingCode(machine.deviceId).key, sealedAccept)).toThrow();
  });
});
