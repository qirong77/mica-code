import { execFileSync } from 'node:child_process';
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  randomBytes
} from 'node:crypto';
import { readFileSync } from 'node:fs';
import { hostname, platform, arch, userInfo } from 'node:os';
import { gunzipSync, gzipSync } from 'node:zlib';

/**
 * 自助注册：本机把「我是谁」的哈希封给中转机，换一个口令回来。
 *
 * 同一台机器重复注册拿到的是同一个口令——中转机按哈希认领，不按请求次数发新口令，
 * 所以重装插件、换会话、点第二次都不会多出一条记录。
 *
 * 申请走一次 ECDH（X25519）：中转机给公钥，本机协商出会话密钥，申请与返回的口令
 * 都封在这把密钥下。口令本身是凭据，不该以明文出现在任何中间环节。
 */

export type RegistrationResult = {
  token: string;
  label: string;
  /** 中转机上新登记了一台机器；false 表示复用已有的那条。 */
  created: boolean;
};

export type MachineIdentity = {
  /** 稳定标识的哈希（只发这个，不发原始值）。 */
  identity: string;
  label: string;
  platform: string;
};

/**
 * 本机标识的原料。
 *
 * 优先用系统级的机器 UUID（macOS 的 IOPlatformUUID、Linux 的 machine-id），
 * 它跟着硬件/系统走，重装插件也不变；拿不到时退回「用户名 + 主机名 + 平台」。
 */
function identityMaterial(): string {
  const os = platform();
  try {
    if (os === 'darwin') {
      const out = execFileSync('ioreg', ['-rd1', '-c', 'IOPlatformExpertDevice'], {
        encoding: 'utf8',
        timeout: 3_000,
        stdio: ['ignore', 'pipe', 'ignore']
      });
      const match = /"IOPlatformUUID"\s*=\s*"([^"]+)"/.exec(out);
      if (match?.[1]) return `uuid:${match[1]}`;
    } else if (os === 'linux') {
      const id = readFileSync('/etc/machine-id', 'utf8').trim();
      if (id) return `machine-id:${id}`;
    }
  } catch {
    // 拿不到系统标识就走下面的组合
  }
  let user = '';
  try {
    user = userInfo().username;
  } catch {
    user = '';
  }
  return `host:${user}|${hostname()}|${os}|${arch()}`;
}

export function machineIdentity(): MachineIdentity {
  const label = hostname().replace(/\.local$/i, '') || '这台机器';
  return {
    identity: createHash('sha256').update(identityMaterial()).digest('hex'),
    label,
    platform: `${platform()}-${arch()}`
  };
}

function channelKey(shared: Buffer, salt: Buffer): Buffer {
  return Buffer.from(hkdfSync('sha256', shared, salt, Buffer.from('mica-relay-register-v1'), 32));
}

function sealPayload(key: Buffer, value: unknown): { iv: string; tag: string; data: string } {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const body = Buffer.concat([cipher.update(gzipSync(Buffer.from(JSON.stringify(value)))), cipher.final()]);
  return {
    iv: iv.toString('base64url'),
    tag: cipher.getAuthTag().toString('base64url'),
    data: body.toString('base64url')
  };
}

function openPayload(key: Buffer, sealed: string): unknown {
  const buffer = Buffer.from(sealed, 'base64url');
  if (buffer.length < 29) throw new Error('返回内容不完整');
  const iv = buffer.subarray(0, 12);
  const tag = buffer.subarray(12, 28);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  const plain = Buffer.concat([decipher.update(buffer.subarray(28)), decipher.final()]);
  return JSON.parse(gunzipSync(plain).toString('utf8'));
}

export type RegisterOptions = {
  relayUrl: string;
  /** 中转机开了接入口令时才需要。 */
  enrollKey?: string;
  label?: string;
  /** 只在测试里替换「这台机器是谁」；运行期一律用本机真实标识。 */
  identity?: MachineIdentity;
  fetcher?: typeof fetch;
  timeoutMs?: number;
};

function relayBase(relayUrl: string): string {
  const trimmed = relayUrl.trim().replace(/\/+$/, '');
  if (!trimmed) throw new Error('还没填中转地址');
  return trimmed;
}

function errorText(body: unknown, status: number): string {
  const code = typeof body === 'object' && body && 'error' in body ? String((body as { error: unknown }).error) : '';
  if (code === 'enroll-key-required') return '这台中转机要求接入口令，先填口令再注册';
  if (code === 'no-capacity') return '这台中转机的机器位满了，先在它上面删掉不用的机器';
  if (code === 'too-many-requests') return '注册太频繁了，等一分钟再试';
  if (code === 'bad-envelope') return '中转机没有读懂这次申请（版本不匹配？）';
  return `中转机返回 ${status}${code ? `（${code}）` : ''}`;
}

export async function registerWithRelay(options: RegisterOptions): Promise<RegistrationResult> {
  const base = relayBase(options.relayUrl);
  const fetcher = options.fetcher ?? fetch;
  const timeout = options.timeoutMs ?? 10_000;
  const machine = options.identity ?? machineIdentity();

  const keyResponse = await fetcher(`${base}/api/register-key`, {
    signal: AbortSignal.timeout(timeout),
    headers: { accept: 'application/json' }
  });
  if (!keyResponse.ok) throw new Error(`拿不到注册公钥：中转机返回 ${keyResponse.status}`);
  const keyBody = (await keyResponse.json()) as { key?: string; requiresKey?: boolean };
  if (!keyBody.key) throw new Error('中转机没有返回注册公钥');
  if (keyBody.requiresKey && !options.enrollKey?.trim()) {
    throw new Error('这台中转机要求接入口令，先填口令再注册');
  }

  const relayPublicDer = Buffer.from(keyBody.key, 'base64url');
  const ephemeral = generateKeyPairSync('x25519');
  const ephemeralDer = ephemeral.publicKey.export({ type: 'spki', format: 'der' });
  const shared = diffieHellman({
    privateKey: ephemeral.privateKey,
    publicKey: createPublicKey({ key: relayPublicDer, format: 'der', type: 'spki' })
  });
  const key = channelKey(shared, relayPublicDer);

  const sealed = sealPayload(key, {
    identity: machine.identity,
    label: options.label?.trim() || machine.label,
    platform: machine.platform,
    ...(options.enrollKey?.trim() ? { key: options.enrollKey.trim() } : {})
  });

  const response = await fetcher(`${base}/api/register`, {
    method: 'POST',
    signal: AbortSignal.timeout(timeout),
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ peer: ephemeralDer.toString('base64url'), ...sealed })
  });
  const body = (await response.json().catch(() => ({}))) as { sealed?: string; error?: string };
  if (!response.ok) throw new Error(errorText(body, response.status));
  if (!body.sealed) throw new Error('中转机没有返回口令');

  const payload = openPayload(key, body.sealed) as Partial<RegistrationResult>;
  const token = typeof payload.token === 'string' ? payload.token : '';
  if (token.length < 16) throw new Error('中转机返回的口令不完整');
  return {
    token,
    label: typeof payload.label === 'string' ? payload.label : machine.label,
    created: payload.created === true
  };
}
