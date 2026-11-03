import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * 口令的存放：macOS 走 Keychain，其它平台退化成插件数据目录里一份 0600 的 JSON。
 *
 * 为什么不放进 `data.json`（主机清单）：那份文件会进备份、会被 `--json` 打印、会被
 * 用户打开看一眼。口令一旦写进去，后面每个读它的地方都要重新想起来「这里不能外泄」——
 * 放进系统的凭据库，插件自己每次现取，清单就可以随便给模型看。
 *
 * Keychain 的写入走 stdin（`security … -w` 不带值时会读两遍口令），所以口令不出现在
 * 任何进程的命令行参数里——`ps` 是别人看得到的。
 */

const SERVICE = 'mica-ssh';
/** Keychain 不可用时的退路（Linux / CI）：同一份文件，权限收紧。 */
export const SECRETS_FILE = 'secrets.json';
const UNSAFE_SHELL = process.platform !== 'darwin';

export function secretKeyOf(hostId: string): string {
  return hostId;
}

function readSecurity(args: string[], input?: string): string | null {
  try {
    return execFileSync('security', args, {
      encoding: 'utf8',
      input,
      stdio: ['pipe', 'pipe', 'ignore'],
      timeout: 15_000,
    });
  } catch {
    return null;
  }
}

function fallbackFile(dataDir: string): string {
  return join(dataDir, SECRETS_FILE);
}

function readFallback(dataDir: string): Record<string, string> {
  try {
    const parsed = JSON.parse(readFileSync(fallbackFile(dataDir), 'utf8')) as Record<string, unknown>;
    const result: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === 'string') result[key] = value;
    }
    return result;
  } catch {
    return {};
  }
}

function writeFallback(dataDir: string, values: Record<string, string>): void {
  const file = fallbackFile(dataDir);
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${process.pid}.tmp`;
  try {
    writeFileSync(temp, `${JSON.stringify(values, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    chmodSync(temp, 0o600);
    renameSync(temp, file);
  } catch (error) {
    rmSync(temp, { force: true });
    throw error;
  }
}

export function hasStoredPassword(hostId: string, dataDir: string): boolean {
  return readPassword(hostId, dataDir) !== null;
}

/** 读口令；没有就返回 null（密码认证的主机缺口令时由调用方给可展示的提示）。 */
export function readPassword(hostId: string, dataDir: string): string | null {
  if (!UNSAFE_SHELL) {
    const value = readSecurity(['find-generic-password', '-s', SERVICE, '-a', secretKeyOf(hostId), '-w']);
    if (value !== null) {
      const trimmed = value.replace(/\r?\n$/, '');
      return trimmed.length > 0 ? trimmed : null;
    }
  }
  return readFallback(dataDir)[secretKeyOf(hostId)] ?? null;
}

export function storePassword(hostId: string, password: string, dataDir: string): void {
  if (!UNSAFE_SHELL) {
    // `-w` 不带值：security 从 stdin 读两遍（口令 + 确认），口令因此不进 argv。
    const stored = readSecurity(
      ['add-generic-password', '-U', '-s', SERVICE, '-a', secretKeyOf(hostId), '-w'],
      `${password}\n${password}\n`,
    );
    if (stored !== null) return;
    // Keychain 写不进去（被锁、无 GUI 会话）就退到文件，至少还能连上。
  }
  writeFallback(dataDir, { ...readFallback(dataDir), [secretKeyOf(hostId)]: password });
}

export function deletePassword(hostId: string, dataDir: string): void {
  if (!UNSAFE_SHELL) {
    readSecurity(['delete-generic-password', '-s', SERVICE, '-a', secretKeyOf(hostId)]);
  }
  const values = readFallback(dataDir);
  if (!(secretKeyOf(hostId) in values)) return;
  delete values[secretKeyOf(hostId)];
  if (Object.keys(values).length === 0) {
    rmSync(fallbackFile(dataDir), { force: true });
    return;
  }
  writeFallback(dataDir, values);
}

/** 口令真正落在哪儿（面板上如实告诉用户，不要让人猜它存在系统里还是目录里）。 */
export function secretsLocation(dataDir: string): string {
  if (!UNSAFE_SHELL) return 'macOS 钥匙串（mica-ssh）';
  return existsSync(fallbackFile(dataDir)) ? `${fallbackFile(dataDir)}（0600）` : `${fallbackFile(dataDir)}（0600，尚未写入）`;
}
