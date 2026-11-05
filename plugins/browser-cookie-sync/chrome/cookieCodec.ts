import { createCipheriv, createDecipheriv, createHash, pbkdf2Sync } from 'node:crypto';

/**
 * Chromium cookie 的落盘加密（`v10`）。
 *
 * 形态（macOS，Chrome 80 之后的库版本 24）：`encrypted_value` = `"v10"` + AES-128-CBC
 * 的密文，明文 = `SHA256(host_key)`（32 字节）+ 真正的 cookie 值。密钥是钥匙串里那句
 * `Chrome Safe Storage` 口令经 PBKDF2-HMAC-SHA1（盐 `saltysalt`、1003 轮、16 字节）派生的，
 * IV 固定为 16 个空格。
 *
 * 两点刻意保留：解密时**按明文自己认**有没有那 32 字节前缀（老库、Linux 上的库里没有），
 * 加密时一律按当前 Chrome 的写法拼上——写回 Chrome 的必须是它认的形态。
 */
export const SAFE_STORAGE_SALT = 'saltysalt';
export const SAFE_STORAGE_ITERATIONS = 1003;
const SAFE_STORAGE_KEY_BYTES = 16;
const V10_IV = Buffer.alloc(16, 0x20);
const HOST_HASH_BYTES = 32;

export function deriveSafeStorageKey(password: string): Buffer {
  return pbkdf2Sync(password, SAFE_STORAGE_SALT, SAFE_STORAGE_ITERATIONS, SAFE_STORAGE_KEY_BYTES, 'sha1');
}

export function hostHash(hostKey: string): Buffer {
  return createHash('sha256').update(String(hostKey || ''), 'utf8').digest();
}

/** 解密一条 `encrypted_value`；解不出来（碎片、换了密钥、未知前缀）返回 null，调用方按「值不可读」处理。 */
export function decryptCookieValue(encrypted: Buffer, hostKey: string, key: Buffer): string | null {
  if (!encrypted || encrypted.length <= 3) return null;
  const prefix = encrypted.subarray(0, 3).toString('latin1');
  if (prefix !== 'v10' && prefix !== 'v11') return null;
  const body = encrypted.subarray(3);
  if (body.length === 0 || body.length % 16 !== 0) return null;

  let plain: Buffer;
  try {
    const decipher = createDecipheriv('aes-128-cbc', key, V10_IV);
    plain = Buffer.concat([decipher.update(body), decipher.final()]);
  } catch {
    return null;
  }

  const hash = hostHash(hostKey);
  if (plain.length >= HOST_HASH_BYTES && plain.subarray(0, HOST_HASH_BYTES).equals(hash)) {
    return plain.subarray(HOST_HASH_BYTES).toString('utf8');
  }
  return plain.toString('utf8');
}

/** 加密成 Chrome 认的形态（总是带 host 前缀，与当前所有 Chrome 一致）。 */
export function encryptCookieValue(value: string, hostKey: string, key: Buffer): Buffer {
  const cipher = createCipheriv('aes-128-cbc', key, V10_IV);
  const plain = Buffer.concat([hostHash(hostKey), Buffer.from(String(value ?? ''), 'utf8')]);
  return Buffer.concat([Buffer.from('v10', 'latin1'), cipher.update(plain), cipher.final()]);
}

/**
 * Chrome 的时间是「1601-01-01 起的微秒数」，与 JS 的秒差一个固定偏移。
 * `0` 在库里表示「没有过期时间」（会话 cookie），不是 1601 年。
 */
const CHROME_EPOCH_OFFSET_SECONDS = 11_644_473_600;

export function chromeTimeToUnixSeconds(value: unknown): number | null {
  const micros = Number(value);
  if (!Number.isFinite(micros) || micros <= 0) return null;
  return micros / 1_000_000 - CHROME_EPOCH_OFFSET_SECONDS;
}

export function unixSecondsToChromeTime(value: number): number {
  return Math.round((Number(value) + CHROME_EPOCH_OFFSET_SECONDS) * 1_000_000);
}
