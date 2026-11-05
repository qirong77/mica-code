import { spawnSync } from 'node:child_process';

/**
 * 直接问系统自带的 `sqlite3`，不为一个 cookie 库引 native 依赖。
 *
 * 为什么不是 `node:sqlite` / `bun:sqlite`：前者在 Node 22 上还要实验开关，后者只在 bun 下
 * 存在，而这个插件在两种宿主里都要跑（桌面端的 app-server 与 `mica plugin-action`）。
 * 读用 `-json`（sqlite3 3.33+，macOS 自带的一直够新），写用一段脚本 + `X'hex'` blob 字面量。
 */

export type SqliteResult = { status: number | null; stdout: string; stderr: string };

export type SqliteRunner = (args: string[], input: string) => SqliteResult;

export const defaultSqliteRunner: SqliteRunner = (args, input) => {
  const result = spawnSync('sqlite3', args, {
    input,
    encoding: 'utf8',
    timeout: 30_000,
    maxBuffer: 64 * 1024 * 1024
  });
  return {
    status: result?.status ?? 1,
    stdout: String(result?.stdout || ''),
    stderr: String(result?.stderr || result?.error || '')
  };
};

export class SqliteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SqliteError';
  }
}

/** 只读查询，返回解析后的行。空结果给 `[]`（`-json` 对空集什么都不打印）。 */
export function queryRows<T = Record<string, unknown>>(
  dbPath: string,
  sql: string,
  { run = defaultSqliteRunner }: { run?: SqliteRunner } = {}
): T[] {
  const result = run(['-readonly', '-json', dbPath], `${sql.trim().replace(/;$/, '')};\n`);
  if (result.status !== 0) {
    const message = result.stderr.trim() || `sqlite3 退出码 ${result.status}`;
    throw new SqliteError(`读 ${dbPath} 失败：${message}`);
  }
  const text = result.stdout.trim();
  if (!text) return [];
  try {
    const parsed = JSON.parse(text) as unknown;
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    throw new SqliteError(`sqlite3 输出不是 JSON：${text.slice(0, 200)}`);
  }
}

/**
 * 一段写脚本，整段在一个事务里跑。
 *
 * `BEGIN IMMEDIATE` 先拿写锁：Chrome 自己也在写这个库，让它先写完比我们半路撞上锁、
 * 再让整批失败强。`busy_timeout` 兜住短暂的锁竞争。
 */
export function execScript(
  dbPath: string,
  body: string,
  { run = defaultSqliteRunner, timeoutMs = 3000 }: { run?: SqliteRunner; timeoutMs?: number } = {}
): void {
  const sql = [
    `PRAGMA busy_timeout=${Math.max(0, Math.round(timeoutMs))};`,
    'BEGIN IMMEDIATE;',
    body.trim(),
    'COMMIT;'
  ].join('\n');
  const result = run(['-bail', dbPath], `${sql}\n`);
  if (result.status !== 0) {
    const message = result.stderr.trim() || `sqlite3 退出码 ${result.status}`;
    throw new SqliteError(`写 ${dbPath} 失败：${message}`);
  }
}

/** SQL 文本字面量：单引号翻倍。cookie 的 name / path 里出现引号不常见，但出现了不能拼坏语句。 */
export function sqlText(value: unknown): string {
  return `'${String(value ?? '').replace(/'/g, "''")}'`;
}

export function sqlBlob(buffer: Buffer): string {
  return `X'${buffer.toString('hex')}'`;
}
