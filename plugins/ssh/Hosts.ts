import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { acquireProcessLock } from '@packages/mica-common/processLock.js';

/**
 * 主机清单：`$MICA_HOME/plugin-data/ssh/data.json`。
 *
 * 写它的一直是「一个进程里的几个入口」——面板动作（配置页 / 对话右侧）与 `ssh_hosts`
 * 工具会同时开着，所以照 schedule 的规矩来：**同一把跨进程锁 + 先写临时文件再 rename**。
 * 现读、改一条、原子写，不把内存里那份整份盖回去。
 *
 * 口令不进这个文件：它属于 `Secrets.ts`（macOS Keychain / 0600 文件）。
 */

export const SSH_DATA_FILE = 'data.json';

export type SshAuth = 'password' | 'key' | 'agent';

export const SSH_AUTH_TYPES: readonly SshAuth[] = ['password', 'key', 'agent'];

export type SshHost = {
  /** 别名，模型在工具调用里就是用它指定机器；同时也是口令的 key。 */
  id: string;
  host: string;
  port: number;
  user: string;
  auth: SshAuth;
  /** `auth: 'key'` 时的私钥路径（允许 `~`）。 */
  keyPath?: string;
  /** 给人看的一句话用途（「测试机」「生产 API」），也进 prompt。 */
  label?: string;
  /** 只读：拒绝任何可能改状态的脚本前的软约束，模型与人都看得见。 */
  readOnly?: boolean;
  /** 首次连接后钉住的主机密钥指纹（`SHA256:…`）。 */
  fingerprint?: string;
  createdAt: string;
  updatedAt: string;
};

export type SshData = {
  version: 1;
  updatedAt: string;
  /** 配置页插件详情里的「运行状态」那一行（清单 `status` 声明的 key）。 */
  hostsSummary?: string;
  hosts: SshHost[];
};

export type HostDraft = {
  id?: string;
  host?: string;
  port?: number | string;
  user?: string;
  auth?: string;
  keyPath?: string;
  label?: string;
  readOnly?: boolean;
};

/** 别名进 prompt、进工具参数、进 ssh 目标串，所以只允许「一眼能念出来」的字符。 */
export const HOST_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,31}$/;
/** 主机名或 IP；不收带空白的输入（那是把整条命令塞进目标串的第一步）。 */
const HOST_ADDRESS_PATTERN = /^[a-zA-Z0-9._:[\]-]{1,255}$/;
const USER_PATTERN = /^[a-zA-Z0-9._-]{1,64}$/;

export function emptyData(): SshData {
  return { version: 1, updatedAt: new Date().toISOString(), hosts: [] };
}

function text(value: unknown, limit: number): string {
  return typeof value === 'string' ? value.trim().slice(0, limit) : '';
}

/** 手改过清单的人写 `true` / `"true"` / `"yes"` 都算数，写别的当没有。 */
function flag(value: unknown): boolean {
  return value === true || value === 'true' || value === 'yes';
}

function normalizeHost(input: unknown): SshHost | null {
  if (!input || typeof input !== 'object') return null;
  const raw = input as Record<string, unknown>;
  const id = text(raw.id, 32);
  const host = text(raw.host, 255);
  const user = text(raw.user, 64);
  if (!HOST_ID_PATTERN.test(id) || !HOST_ADDRESS_PATTERN.test(host) || !USER_PATTERN.test(user)) return null;
  const port = Number(raw.port);
  const auth = SSH_AUTH_TYPES.includes(raw.auth as SshAuth) ? (raw.auth as SshAuth) : 'agent';
  const keyPath = text(raw.keyPath, 512);
  const fingerprint = text(raw.fingerprint, 200);
  const now = new Date().toISOString();
  return {
    id,
    host,
    port: Number.isInteger(port) && port > 0 && port <= 65535 ? port : 22,
    user,
    auth,
    ...(auth === 'key' && keyPath ? { keyPath } : {}),
    ...(text(raw.label, 60) ? { label: text(raw.label, 60) } : {}),
    // 手改过清单的人写 `"readOnly": true` 或 `"yes"` 都算数，写别的当没有。
    ...(flag(raw.readOnly) ? { readOnly: true } : {}),
    ...(fingerprint ? { fingerprint } : {}),
    createdAt: text(raw.createdAt, 40) || now,
    updatedAt: text(raw.updatedAt, 40) || now,
  };
}

/** 读不出来就当没有：清单坏了应该去面板重配，而不是让插件起不来。 */
export function readData(file: string): SshData {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as { hosts?: unknown };
    const hosts = Array.isArray(parsed.hosts)
      ? parsed.hosts.map((entry) => normalizeHost(entry)).filter((entry): entry is SshHost => entry !== null)
      : [];
    return { version: 1, updatedAt: new Date().toISOString(), hosts };
  } catch {
    return emptyData();
  }
}

export function writeData(file: string, data: SshData): void {
  mkdirSync(dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`;
  try {
    const summary =
      data.hosts.length === 0
        ? '尚未添加服务器'
        : `${data.hosts.length} 台（${data.hosts.map((host) => host.id).join('、')}）`;
    writeFileSync(temp, `${JSON.stringify({ ...data, hostsSummary: summary }, null, 2)}\n`, 'utf8');
    renameSync(temp, file);
  } catch (error) {
    rmSync(temp, { force: true });
    throw error;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

const LOCK_ATTEMPTS = 6;
const LOCK_RETRY_MS = 80;

/** 在跨进程锁里读改写一次；`mutate` 抛错原样抛出去（那是给模型/用户看的原因）。 */
export async function mutateData<T>(
  file: string,
  mutate: (data: SshData) => { data: SshData; result: T },
): Promise<T> {
  for (let attempt = 0; attempt < LOCK_ATTEMPTS; attempt += 1) {
    const release = acquireProcessLock(`${file}.lock`);
    if (!release) {
      await sleep(LOCK_RETRY_MS);
      continue;
    }
    try {
      const outcome = mutate(readData(file));
      writeData(file, { ...outcome.data, version: 1, updatedAt: new Date().toISOString() });
      return outcome.result;
    } finally {
      release();
    }
  }
  throw new Error('主机清单正在保存（另一个入口在写），稍后再试一次');
}

/** 按别名解析；也接受直接写地址（`ssh_hosts` 的模型偶尔会这么干，不留模糊匹配）。 */
export function findHost(data: SshData, name: string): SshHost | null {
  const needle = name.trim();
  if (!needle) return null;
  return data.hosts.find((entry) => entry.id === needle) ?? data.hosts.find((entry) => entry.host === needle) ?? null;
}

export type HostUpsertResult = { data: SshData; host: SshHost; created: boolean };

/**
 * 新建或更新一台机器。
 *
 * `password` 不在这里出现（它属于 Secrets），只校验「除了口令之外的部分」——口令缺失
 * 由调用方在存完之后补上，避免一个只改用途的编辑把口令抹掉。
 */
export function upsertHost(data: SshData, draft: HostDraft): HostUpsertResult {
  const id = text(draft.id, 32);
  if (!HOST_ID_PATTERN.test(id)) {
    throw new Error('别名只能用字母、数字、`.`、`_`、`-`（1–32 位），例如 `test` / `prod-api`');
  }
  const host = text(draft.host, 255);
  if (!HOST_ADDRESS_PATTERN.test(host)) throw new Error('主机地址只填域名或 IP，不要带用户名、端口或空格');
  const user = text(draft.user, 64);
  if (!USER_PATTERN.test(user)) throw new Error('用户名只能包含字母、数字、`.`、`_`、`-`');
  const portText = typeof draft.port === 'string' ? draft.port.trim() : draft.port;
  const port = portText === undefined || portText === '' ? 22 : Number(portText);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) throw new Error('端口必须是 1–65535 之间的整数');
  const auth = SSH_AUTH_TYPES.includes(draft.auth as SshAuth) ? (draft.auth as SshAuth) : 'agent';
  const keyPath = text(draft.keyPath, 512);
  if (auth === 'key' && !keyPath) throw new Error('用密钥认证时要填私钥路径（例如 ~/.ssh/id_ed25519）');

  const now = new Date().toISOString();
  const existingIndex = data.hosts.findIndex((entry) => entry.id === id);
  const existing = existingIndex >= 0 ? data.hosts[existingIndex] : null;
  const next: SshHost = {
    id,
    host,
    port,
    user,
    auth,
    ...(auth === 'key' ? { keyPath } : {}),
    ...(text(draft.label, 60) ? { label: text(draft.label, 60) } : {}),
    ...(flag(draft.readOnly) ? { readOnly: true } : {}),
    // 换了地址或端口就是另一台机器：旧指纹必须作废，否则连上去必然报「密钥已变更」。
    ...(existing?.host === host && existing.port === port && existing.fingerprint
      ? { fingerprint: existing.fingerprint }
      : {}),
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
  const hosts =
    existingIndex >= 0
      ? data.hosts.map((entry, index) => (index === existingIndex ? next : entry))
      : [...data.hosts, next];
  return { data: { ...data, hosts }, host: next, created: existingIndex < 0 };
}
