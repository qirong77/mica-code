import { createHash, randomBytes } from 'node:crypto';

const BASE32_ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567';

/** RFC 4648 base32 (lowercase, no padding). */
export function base32Encode(bytes: Uint8Array): string {
  let value = 0;
  let bits = 0;
  let out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32_ALPHABET[(value >>> (bits - 5)) & 31]!;
      bits -= 5;
    }
    value &= (1 << bits) - 1;
  }
  if (bits > 0) out += BASE32_ALPHABET[(value << (5 - bits)) & 31]!;
  return out;
}

export function base32Decode(text: string): Uint8Array {
  const clean = text.trim().toLowerCase().replace(/[\s-]/g, '');
  let value = 0;
  let bits = 0;
  const out: number[] = [];
  for (const char of clean) {
    const index = BASE32_ALPHABET.indexOf(char);
    if (index === -1) throw new Error(`invalid base32 character: ${char}`);
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
    value &= (1 << bits) - 1;
  }
  return Uint8Array.from(out);
}

/** Group a compact string for humans without changing the parsed value. */
export function groupChars(text: string, size = 5): string {
  const groups: string[] = [];
  for (let index = 0; index < text.length; index += size) {
    groups.push(text.slice(index, index + size));
  }
  return groups.join('-');
}

export function randomId(prefix: string, bytes = 9): string {
  return `${prefix}_${base32Encode(randomBytes(bytes))}`;
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

export function sha256Base64Url(input: string | Uint8Array): string {
  return createHash('sha256').update(input).digest('base64url');
}

/**
 * Stable, opaque reference for relay-visible identifiers.
 *
 * The relay only ever sees this hash: workspace paths and Mica session ids stay
 * local to the machine that owns them.
 */
export function opaqueRef(...parts: string[]): string {
  const hash = createHash('sha256');
  for (const part of parts) {
    hash.update(part);
    hash.update('\u0000');
  }
  return base32Encode(hash.digest().subarray(0, 12));
}

/** Short human fingerprint for out-of-band comparison. */
export function fingerprintOf(publicKey: string): string {
  const digest = createHash('sha256').update(publicKey).digest().subarray(0, 10);
  return groupChars(base32Encode(digest).toUpperCase(), 4);
}

export const DEVICE_ID_PATTERN = /^[mc]_[a-z2-7]{15}$/;
export const WORKSPACE_REF_PATTERN = /^[a-z2-7]{20}$/;
export const SESSION_REF_PATTERN = /^[a-z2-7]{20}$/;
