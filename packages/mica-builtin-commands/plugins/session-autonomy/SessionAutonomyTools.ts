import { spawnSync } from 'node:child_process';
import { relative } from 'node:path';
import { MicaTool, type ToolExecuteCallbacks, type ToolInput } from '@packages/mica-tools/index.js';
import type { CommandAgent, CommandRuntimeServices } from '@packages/mica-builtin-commands/index.js';
import {
  listRecentSessionFiles,
  readSessionWrites,
  type RecentSessionFile,
  type SessionTurnLock,
} from '@packages/mica-session/index.js';
import { readPeerSnapshot, type SessionPeerDeps } from './sessionPeers.js';

export type SessionToolDeps = SessionPeerDeps & {
  /** 最近结束的会话枚举；测试注入用，默认读 `$MICA_HOME/sessions/*.json` 的文件头。 */
  listRecentSessions?: (sinceMs: number) => RecentSessionFile[];
  /** 进程描述；测试注入用，默认 `ps -o command=`。 */
  describeProcess?: (pid: number) => string | undefined;
  /** 某个会话本轮写过的文件；测试注入用，默认读 `.turn-locks/<id>.writes`。 */
  listSessionWrites?: (sessionId: string) => { path: string; at: string }[];
};

/** `hours` 的上限：超过一个月的窗口对排查「谁动过工作区」没有意义。 */
const MAX_HOURS = 24 * 30;
const HOUR_MS = 60 * 60 * 1000;
/** 一行里最多列几个文件；再多对判断归属没用，只是噪音。 */
const MAX_WRITES_SHOWN = 8;

type CallerAgent = Pick<CommandAgent, 'taskOwnerId' | 'getSnapshot' | 'config' | 'role'>;

function callerAgent(callbacks?: ToolExecuteCallbacks): CallerAgent | undefined {
  const context = callbacks?.context;
  if (!context || typeof context !== 'object') return undefined;
  // Subagent tool contexts carry a taskId (see PluginSubagentHost); session tools must
  // never be driven from a subagent, even if the subagent shares the parent's
  // tool registry. The primaryAgentOnly filter already hides them, this is a
  // defense-in-depth guard.
  if ((context as { taskId?: unknown }).taskId !== undefined) return undefined;
  const agent = (context as { agent?: unknown }).agent;
  if (!agent || typeof agent !== 'object') return undefined;
  return agent as CallerAgent;
}

function ownerKeyOf(agent: CallerAgent | undefined): string | undefined {
  const key = agent?.taskOwnerId;
  return typeof key === 'string' && key.length > 0 ? key : undefined;
}

function isActiveAgent(services: CommandRuntimeServices, agent: CallerAgent | undefined): boolean {
  const active = services.getCurrentAgent?.();
  return Boolean(agent && active && ownerKeyOf(agent) === ownerKeyOf(active as unknown as CallerAgent));
}

function notAvailable(message: string): string {
  return `session 工具只能在交互式主会话中使用（${message}）`;
}

const SESSION_READ_GUIDANCE = [
  '如何读这些记录（务必按顺序，避免一次性灌入大量 context）:',
  '- session 文件是完整快照，可能有几十 MB（含图片 Base64 与全部工具调用历史）。不要用 read_file 直接读整个文件。',
  '- 只想了解"对方在处理什么事"时，读 snapshot.conversationMessages：UI 层对话，元素形如 { role: "user"|"assistant", content }，比 snapshot.messages 干净得多。',
  '- 推荐顺序：先 grep_search 关键词确认相关 → grep_search 定位 `"conversationMessages"` 的行号 → read_file 从该 offset 分段读（一次 50-150 行）。',
  '- 需要确认"对方改了哪个文件"时再看 snapshot.messages 里的 tool_calls：同样先 grep_search 目标文件名定位，不要整读。',
  '- 文件结构: { version, revision, id, title, titleSource, createdAt, updatedAt, cwd, turnState, snapshot: { providerId, protocol, model, effort, role, contextWindowSize?, messages[], conversationMessages[], usageHistory[], lastUsage?, subagentUsageHistory? } }',
  '- turnState: running / completed / aborted / error。running 但持有进程已消失，说明上一轮被中断（崩溃残留），不代表现在有人写入。',
].join('\n');

function formatElapsed(startedAt: string): string {
  const started = Date.parse(startedAt);
  if (!Number.isFinite(started)) return '时间未知';
  const elapsed = Date.now() - started;
  if (elapsed < 60_000) return '刚刚开始';
  const minutes = Math.floor(elapsed / 60_000);
  if (minutes < 60) return `已运行 ${minutes} 分钟`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `已运行 ${hours} 小时 ${minutes % 60} 分`;
  return `已运行 ${Math.floor(hours / 24)} 天`;
}

function formatAgo(timestamp: string | undefined): string {
  const parsed = Date.parse(timestamp ?? '');
  if (!Number.isFinite(parsed)) return '时间未知';
  const elapsed = Date.now() - parsed;
  if (elapsed < 60_000) return '刚刚';
  const minutes = Math.floor(elapsed / 60_000);
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时 ${minutes % 60} 分前`;
  return `${Math.floor(hours / 24)} 天前`;
}

function readHours(input: ToolInput): number {
  const raw = input.hours;
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return 0;
  return Math.min(MAX_HOURS, Math.max(0, Math.floor(raw)));
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

export class ToolSessionPeers extends MicaTool {
  constructor(private readonly deps: SessionToolDeps) {
    super(
      'session_peers',
      [
        '列出当前正在运行的 Mica 实例（其他窗口/终端里的 TUI、mica exec、desktop 的 app-server 进程），返回各自 session 缓存文件路径与读取方法。',
        '同一工作目录的并发会话还会列出它本轮写过的文件——`git status` / `git diff` 不记录作者，判断一批未提交改动属于谁只能靠这里。',
        '文件内容与预期不符、改动突然消失、或要确认有没有别的会话在同一个仓库工作时，先调用它再动手，不要凭「本轮开始时工作区是干净的」推断归属。',
        '只读，不修改任何东西。注意：只列出正在执行 turn 的实例，空闲实例不会改动文件，因此不在列表中。',
        '默认只列正在运行的实例；传 hours 后额外列出最近 N 小时内结束的会话（已释放 turn 锁，仍可能刚改过工作区），0 表示不列。',
      ].join(' '),
      {
        type: 'object',
        properties: {
          hours: {
            type: 'number',
            description: '额外列出最近 N 小时内结束（不再持有 turn 锁）的会话；默认 0 表示不列。',
          },
        },
        additionalProperties: false,
      },
      { readOnly: true },
    );
  }

  async execute(input: ToolInput, callbacks?: ToolExecuteCallbacks): Promise<string> {
    const agent = callerAgent(callbacks);
    if (!isActiveAgent(this.deps.services, agent)) return notAvailable('未找到当前 agent');
    const snapshot = readPeerSnapshot(this.deps);
    const { currentSessionId, running, stale } = snapshot;
    const describe = this.deps.describeProcess ?? describeProcessCommand;
    const hours = readHours(input);
    // Same working directory is the interesting case: that is the instance most
    // likely to touch the files this session is editing.
    const sameCwd = (lock: SessionTurnLock): boolean =>
      snapshot.sameCwd.some((peer) => peer.sessionId === lock.sessionId);

    const header =
      running.length === 0
        ? '当前没有正在运行的 Mica 会话（按 `$MICA_HOME/sessions/.turn-locks` 的持有进程是否存活判定）。'
        : `正在运行的 Mica 会话：${running.length} 个（按 turn 锁持有进程是否存活判定）`;
    const lines: string[] = [header];

    running.forEach((lock, index) => {
      const isSelf = Boolean(currentSessionId) && lock.sessionId === currentSessionId;
      const command = describe(lock.pid);
      const marker = isSelf ? '（本会话）' : sameCwd(lock) ? '（与本会话同一工作目录）' : '';
      lines.push('', `${index + 1}. ${lock.sessionId}${marker}`);
      lines.push(`   pid: ${lock.pid}${command ? ` · ${truncate(command, 100)}` : ''}`);
      lines.push(`   标题: ${lock.title ?? '(未读到)'}`);
      lines.push(`   cwd: ${lock.cwd ?? '(未读到)'}`);
      const meta = [
        lock.model ? `model ${lock.model}` : '',
        lock.turnState ? `turnState ${lock.turnState}` : '',
        `本轮${formatElapsed(lock.startedAt)}（自 ${lock.startedAt || '未知'}）`,
      ].filter(Boolean);
      lines.push(`   ${meta.join(' · ')}`);
      lines.push(`   session 文件: ${lock.sessionPath}`);
      if (!isSelf && sameCwd(lock)) {
        const written = this.peerWrites(lock);
        if (written) lines.push(`   ${written}`);
      }
    });

    if (running.length > 0) {
      const others = running.filter((lock) => lock.sessionId !== currentSessionId);
      if (others.length === 0) lines.push('', '除本会话外，没有其他 Mica 会话在运行。');
    }
    if (snapshot.sameCwd.length > 0) {
      lines.push(
        '',
        '注意：上面标了「与本会话同一工作目录」的会话会改同一批文件。`git status` / `git diff` 不记录作者，' +
          '因此「本轮开始时工作区是干净的」推不出「现在的改动都是我的」；不属于本会话的改动只能报告，不能回滚或还原。',
      );
    }
    if (stale.length > 0) {
      lines.push(
        '',
        `另有 ${stale.length} 个残留 turn 锁（持有进程已退出，当前无人写入）: ${stale
          .map((lock) => `${lock.sessionId}(pid ${lock.pid})`)
          .join(', ')}`,
      );
    }

    if (hours > 0) {
      // Running sessions already have their own block and a leftover lease is
      // reported above: what is new here is "ended recently, still warm".
      const busy = new Set(running.map((lock) => lock.sessionId));
      if (currentSessionId) busy.add(currentSessionId);
      const listRecent =
        this.deps.listRecentSessions ?? ((sinceMs: number) => listRecentSessionFiles({ since: sinceMs }));
      const ended = listRecent(Date.now() - hours * HOUR_MS).filter((session) => !busy.has(session.sessionId));
      lines.push(
        '',
        ended.length === 0
          ? `最近 ${hours} 小时内没有已结束的其他会话。`
          : `最近 ${hours} 小时内结束的会话：${ended.length} 个（已释放 turn 锁，仍可能刚改过工作区）`,
      );
      ended.forEach((session, index) => {
        lines.push('', `${index + 1}. ${session.sessionId}`);
        lines.push(`   标题: ${session.title ?? '(未读到)'}`);
        lines.push(`   cwd: ${session.cwd ?? '(未读到)'}`);
        const meta = [
          session.turnState ? `turnState ${session.turnState}` : '',
          session.model ? `model ${session.model}` : '',
          `最后写入${formatAgo(session.updatedAt ?? session.modifiedAt)}`,
        ].filter(Boolean);
        lines.push(`   ${meta.join(' · ')}`);
        lines.push(`   session 文件: ${session.sessionPath}`);
      });
    }

    lines.push('', SESSION_READ_GUIDANCE);
    return lines.join('\n');
  }

  /**
   * 这个会话本轮写过哪些文件。
   *
   * 只对同一工作目录的并发会话有用：那正是「同一批文件被另一只手改过」的场景。
   * 台账来自工具层的写入记录，`run_shell` 里的重定向不在其中，所以它只当证据之一。
   */
  private peerWrites(lock: SessionTurnLock): string | undefined {
    const read = this.deps.listSessionWrites ?? ((sessionId: string) => readSessionWrites(sessionId));
    let records: { path: string; at: string }[];
    try {
      records = read(lock.sessionId);
    } catch {
      return undefined;
    }
    const since = Date.parse(lock.startedAt);
    const seen = new Set<string>();
    const files: string[] = [];
    for (const record of records) {
      const at = Date.parse(record.at);
      if (Number.isFinite(since) && Number.isFinite(at) && at < since) continue;
      const rel = lock.cwd ? relative(lock.cwd, record.path) : record.path;
      const label = rel && !rel.startsWith('..') ? rel : record.path;
      if (seen.has(label)) continue;
      seen.add(label);
      files.push(label);
    }
    if (files.length === 0) return undefined;
    const head = files.slice(0, MAX_WRITES_SHOWN);
    const rest = files.length - head.length;
    return `本轮写过的文件: ${head.join(', ')}${rest > 0 ? ` (+${rest})` : ''}`;
  }

  onToolUseDisplayText(): string {
    return '查看运行中的 Mica 会话';
  }
}

function describeProcessCommand(pid: number): string | undefined {
  try {
    const result = spawnSync('ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8', timeout: 1000 });
    const command = result.stdout?.split('\n')[0]?.trim();
    return command ? command : undefined;
  } catch {
    return undefined;
  }
}
