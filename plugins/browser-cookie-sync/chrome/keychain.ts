import { spawnSync } from 'node:child_process';

/**
 * 从登录钥匙串里取 Chromium 的 `Safe Storage` 口令，再派生成 cookie 的 AES 密钥。
 *
 * macOS 上这一步**只能**问 `security`：钥匙串项的 ACL 决定谁能读它，第一次会弹一次系统
 * 授权（钥匙串访问），点了「始终允许」之后才不再打扰。插件进程自己没有 app 身份，也不该
 * 为了读一条口令去链接 Security.framework —— 与 ssh 插件走系统 OpenSSH 是同一个取舍。
 */

/** 只用来问钥匙串的最小接口，测试里替身即可。 */
export type SecurityRunner = (args: string[]) => {
  status: number | null;
  stdout: string;
  stderr: string;
};

export const defaultSecurityRunner: SecurityRunner = (args) => {
  const result = spawnSync('security', args, { encoding: 'utf8', timeout: 30000 });
  return {
    status: result?.status ?? 1,
    stdout: String(result?.stdout || ''),
    stderr: String(result?.stderr || result?.error || '')
  };
};

export class KeychainDenied extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'KeychainDenied';
  }
}

export type SafeStorageSecret = { secret: string; cached: boolean };

const cache = new Map<string, string>();
/** 被拒过一次就别每轮都去戳系统弹窗：同一进程里隔一分钟再试。 */
const deniedAt = new Map<string, number>();
const DENIED_TTL_MS = 60_000;

export function resetSafeStorageCache(): void {
  cache.clear();
  deniedAt.clear();
}

/**
 * 读 `Chrome Safe Storage`。
 *
 * 失败分两类：钥匙串里根本没有这一项（装了别的浏览器 / Chrome 还没登录过任何站点），
 * 和人把弹窗点了「拒绝」（`KeychainDenied`，需要用户去钥匙串里改授权，重试才有意义）。
 */
export function readSafeStorageSecret(
  { service, account }: { service: string; account: string },
  {
    run = defaultSecurityRunner,
    now = Date.now
  }: { run?: SecurityRunner; now?: () => number } = {}
): SafeStorageSecret {
  const key = `${service}\u0000${account}`;
  const cached = cache.get(key);
  if (cached) return { secret: cached, cached: true };

  const denied = deniedAt.get(key);
  if (denied !== undefined && now() - denied < DENIED_TTL_MS) {
    throw new KeychainDenied(
      `钥匙串访问被拒绝：${service}。到「钥匙串访问」里把这一项的访问权限改成允许，或者重试一次再点「允许」`
    );
  }

  const result = run(['find-generic-password', '-w', '-s', service, '-a', account]);
  if (result.status !== 0) {
    const message = result.stderr.trim() || `security 退出码 ${result.status}`;
    // 44 = errSecItemNotFound；其它多半是用户点了拒绝或钥匙串锁着
    if (/could not be found|The specified item/i.test(message) || result.status === 44) {
      throw new Error(`钥匙串里没有 ${service}（${account}）：这个浏览器可能还没存过任何登录态`);
    }
    deniedAt.set(key, now());
    throw new KeychainDenied(`读不到 ${service}：${message}`);
  }

  const secret = result.stdout.replace(/\n$/, '');
  if (!secret) throw new Error(`钥匙串里的 ${service} 是空的`);
  cache.set(key, secret);
  return { secret, cached: false };
}
