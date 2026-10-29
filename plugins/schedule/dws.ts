import { execFile } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

/**
 * D-Chat 的本地 CLI（`dws`）调用层。
 *
 * 群公告没有独立接口：公告只在**被修改**时作为一条 `subtype=announcement` 的消息进入消息
 * 流，所以「当前公告」只能靠导出最近一段时间的消息再取最后一条。这也决定了这个插件的能力
 * 边界——看不到窗口里改过的公告，就只能说「不知道」，不能编。
 *
 * 这里只管跑命令与读产出，时间窗口、并发与取舍都在 `refresh.ts`。
 */

const execFileAsync = promisify(execFile);

/** 单次命令的上限：导出大群的历史可能几十秒，但不能无止境挂着。 */
const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_BUFFER = 64 * 1024 * 1024;

export type DwsCommand = {
  /** 真正执行的程序（`bash` 或二进制本身）。 */
  file: string;
  /** 放在最前面的固定参数（脚本路径）。 */
  prefix: string[];
};

/** 用户没填时默认去这几个位置找：官方 skill 里的脚本、PATH 上的二进制。 */
export function resolveDws(configured: string | undefined): DwsCommand | null {
  const value = (configured ?? '').trim();
  if (value) {
    const expanded = value.startsWith('~/') ? join(homedir(), value.slice(2)) : value;
    if (expanded.endsWith('.sh')) return { file: 'bash', prefix: [expanded] };
    return { file: expanded, prefix: [] };
  }
  const bundled = join(
    homedir(),
    '.SmartWork/skills/smartwork-cli/smartwork-shared/assets/dws-unix.sh',
  );
  if (existsSync(bundled)) return { file: 'bash', prefix: [bundled] };
  // 装过独立版本时 PATH 上会有 dws；找不到就是没配，由调用方报一条健康状态。
  return { file: 'dws', prefix: [] };
}

export type DwsRunner = (args: string[], options?: { timeoutMs?: number }) => Promise<string>;

/** 跑一条 `dws` 命令，返回 stdout（文本模式就够了，JSON 由调用方自己解析文件或输出）。 */
export function createDwsRunner(command: DwsCommand): DwsRunner {
  return async (args, options) => {
    try {
      const { stdout } = await execFileAsync(command.file, [...command.prefix, ...args], {
        timeout: options?.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        maxBuffer: MAX_BUFFER,
        env: process.env,
      });
      return stdout;
    } catch (error) {
      const failure = (error ?? {}) as { stdout?: unknown; stderr?: unknown; message?: unknown };
      const stdout = typeof failure.stdout === 'string' ? failure.stdout : '';
      const stderr = typeof failure.stderr === 'string' ? failure.stderr : '';
      const message = typeof failure.message === 'string' ? failure.message : String(error);
      const detail = (stderr || stdout || message).trim();
      throw new Error(firstLine(detail) || 'dws 命令失败');
    }
  };
}

function firstLine(text: string): string {
  return text.split('\n').map((line) => line.trim()).find(Boolean) ?? '';
}

/** 读一份 `dws` 写出来的 JSON 文件；读完就删，缓存目录里不留历史导出。 */
function readJsonFile(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } finally {
    rmSync(path, { force: true });
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export type DwsChat = {
  id: string;
  name: string;
  type: string;
  /** 最后一条消息的时间戳（毫秒），用来判断哪些群最近有动静。 */
  latestTs: number;
};

/** 群列表（`chat +dump-chats`），按最近活跃排序由调用方决定。 */
export async function listChats(
  run: DwsRunner,
  cacheDir: string,
): Promise<DwsChat[]> {
  const file = join(cacheDir, `chats-${process.pid}.json`);
  await run(['--output', 'json', 'chat', '+dump-chats', file], { timeoutMs: 120_000 });
  const payload = asRecord(readJsonFile(file));
  const data = asRecord(payload?.data);
  const chats = Array.isArray(data?.chats) ? data!.chats : [];
  const result: DwsChat[] = [];
  for (const entry of chats) {
    const chat = asRecord(entry);
    const id = typeof chat?.vchannel_id === 'string' ? chat.vchannel_id : '';
    const name = typeof chat?.name === 'string' ? chat.name : '';
    if (!id || !name) continue;
    result.push({
      id,
      name,
      type: typeof chat?.type === 'string' ? chat.type : '',
      latestTs: typeof chat?.latest_ts === 'number' ? chat.latest_ts : 0,
    });
  }
  return result;
}

/** 公告消息里我们用到的那几个字段。 */
export type Announcement = {
  text: string;
  /** 公告最后一次改动的时间（毫秒）。 */
  updatedAt: number;
  author: string;
};

/** 导出某个群在时间窗口里的消息，取最新一条公告；没有公告就是 null。 */
export async function latestAnnouncement(
  run: DwsRunner,
  options: {
    chatId: string;
    from: string;
    to: string;
    cacheDir: string;
    /** 窗口内消息量的上限：太热闹的群截断时，公告仍然按「窗口里出现过」来算。 */
    limit?: number;
    timeoutMs?: number;
  },
): Promise<Announcement | null> {
  const file = join(options.cacheDir, `chat-${options.chatId}-${process.pid}.json`);
  await run(
    [
      '--output',
      'json',
      'message',
      '+dump-by-chat',
      '--by-chat-id',
      options.chatId,
      '--from',
      options.from,
      '--to',
      options.to,
      '--limit',
      String(options.limit ?? 3000),
      file,
    ],
    { timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS },
  );
  const payload = asRecord(readJsonFile(file));
  const data = asRecord(payload?.data);
  const messages = Array.isArray(data?.messages) ? data!.messages : [];
  let latest: Announcement | null = null;
  for (const entry of messages) {
    const message = asRecord(entry);
    if (message?.subtype !== 'announcement') continue;
    const text = typeof message.text === 'string' ? message.text : '';
    if (!text.trim()) continue;
    const content = asRecord(message.content);
    const author = asRecord(content?.author);
    const fullname =
      typeof author?.fullname === 'string' && author.fullname.trim()
        ? author.fullname.trim()
        : typeof author?.name === 'string'
          ? author.name
          : '';
    const updatedAt = typeof message.created_ts === 'number' ? message.created_ts : 0;
    if (!latest || updatedAt >= latest.updatedAt) latest = { text, updatedAt, author: fullname };
  }
  return latest;
}

/** 当前登录的人（`user info --self`）；拿不到返回空串，不影响排期本身。 */
export async function readSelf(run: DwsRunner): Promise<string> {
  try {
    const stdout = await run(['--output', 'json', 'user', 'info', '--self'], { timeoutMs: 20_000 });
    const payload = asRecord(JSON.parse(stdout));
    const user = asRecord(asRecord(payload?.data)?.user);
    const fullname = typeof user?.fullname === 'string' ? user.fullname.trim() : '';
    return fullname || (typeof user?.name === 'string' ? user.name : '');
  } catch {
    return '';
  }
}
