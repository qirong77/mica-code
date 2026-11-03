import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * 口令的存放：插件数据目录里一份 **0600 的本地 JSON**。
 *
 * 为什么不用系统钥匙串：钥匙串会弹授权框、在没有 GUI 会话的环境里直接失败，而且它把
 * 「这台机器上的一个插件」和用户的登录钥匙串绑在一起——换个 MICA_HOME 做隔离实例时，
 * 两个实例还会互相看到同一份口令。插件自己的目录里一个 0600 文件就够了，范围也只到
 * 这份安装。
 *
 * 它是**明文**。这在本机是明确接受的取舍（用户自己的机器、自己的目录、权限 0600），
 * 换来的是「口令不会跑到别处」。因此下面三条是硬约束，改这个文件时不要破坏：
 *
 * 1. 绝不进 `data.json`：那份文件给模型看、被 `--json` 打印、被备份带走；
 * 2. 绝不进 system prompt、工具参数、工具结果、审计日志——模型永远只给 `host` 别名；
 * 3. 面板视图不回填口令：`plugins/ssh/Panel.ts` 只写空串 + 「已保存」提示，页面因此
 *    永远不会把口令渲染到屏幕上（截图、旁人、分享页面都看不到）。
 *
 * 连接时它只出现在两处：本文件的读取缓冲，以及 0600 的临时 askpass 文件（见
 * `Remote.ts` 的 `createAskpass`，调用结束立刻删除）——都不经过任何模型通道。
 */

export const SECRETS_FILE = 'secrets.json';

export function secretKeyOf(hostId: string): string {
  return hostId;
}

function secretsFile(dataDir: string): string {
  return join(dataDir, SECRETS_FILE);
}

function readAll(dataDir: string): Record<string, string> {
  try {
    const parsed = JSON.parse(readFileSync(secretsFile(dataDir), 'utf8')) as Record<string, unknown>;
    const result: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === 'string') result[key] = value;
    }
    return result;
  } catch {
    return {};
  }
}

function writeAll(dataDir: string, values: Record<string, string>): void {
  const file = secretsFile(dataDir);
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
  const value = readAll(dataDir)[secretKeyOf(hostId)];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

export function storePassword(hostId: string, password: string, dataDir: string): void {
  writeAll(dataDir, { ...readAll(dataDir), [secretKeyOf(hostId)]: password });
}

export function deletePassword(hostId: string, dataDir: string): void {
  const values = readAll(dataDir);
  if (!(secretKeyOf(hostId) in values)) return;
  delete values[secretKeyOf(hostId)];
  if (Object.keys(values).length === 0) {
    rmSync(secretsFile(dataDir), { force: true });
    return;
  }
  writeAll(dataDir, values);
}

/** 口令真正落在哪儿（面板上如实告诉用户：本机明文、0600，不进钥匙串）。 */
export function secretsLocation(dataDir: string): string {
  const file = secretsFile(dataDir);
  return existsSync(file)
    ? `${file}（本机 0600 明文文件，不进钥匙串）`
    : `${file}（本机 0600 明文文件，尚未写入）`;
}
