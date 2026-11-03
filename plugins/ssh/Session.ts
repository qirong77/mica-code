import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { buildSshArgs, createAskpass, disposeAskpass, shellQuote, type RemoteContext } from './Remote.js';
import type { SshHost } from './Hosts.js';
import { readPassword } from './Secrets.js';

/**
 * 持久会话：一台机器上挂着一条 `bash`，状态（`cd`、环境变量、venv）跨调用保留。
 *
 * 为什么需要它：一次性调用撞的是**工具超时**，而 `npm install`、`make`、`docker build`
 * 天然比它长。把它们塞进一个「能分段等」的会话里，模型就不会因为「命令跑不完」而被迫
 * 拆成十几条猜测式的短命令——那才是最慢的用法。
 *
 * 为什么用 sentinel 而不是猜提示符：PS1 千奇百怪（zsh 主题、conda、k8s 上下文），还有
 * 进度条把行刷花。所以每条命令后面追加一句「打印一个不可见标记 + 退出码」，插件在字节流
 * 里等这个标记——不依赖远端任何配置。
 *
 * 为什么用 `-T`（不要 pty）：pty 会把行尾变成 `\r\n`、回显输入、按 80 列折行，这些都让
 * 「结构化地读结果」变复杂。代价是做不了 vim/top 这类全屏交互——那本来就不该由模型来点。
 */

const MARK = '\u001e';
const IDLE_CLOSE_MS = 60 * 60 * 1000;

type Waiter = {
  token: string;
  /** 超时之后再来的读取请求挂到同一批 resolver 上，等到真结果。 */
  resolvers: Array<(value: SessionWaitResult) => void>;
};

export type SessionWaitResult = {
  output: string;
  exitCode: number | null;
  timedOut: boolean;
  dead?: boolean;
};

export type SessionInfo = {
  id: string;
  hostId: string;
  target: string;
  cwd: string;
  createdAt: number;
  lastUsedAt: number;
  running: boolean;
  closed: boolean;
};

type OpenSession = {
  id: string;
  host: SshHost;
  child: ChildProcessWithoutNullStreams;
  buffer: string;
  waiter: Waiter | null;
  timer: NodeJS.Timeout | null;
  createdAt: number;
  lastUsedAt: number;
  cwd: string;
  closed: boolean;
  askpass: ReturnType<typeof createAskpass>;
  counter: number;
  /**
   * 上一条命令的终态（含真实退出码）。
   *
   * 等待超时那一次已经把手上的输出交出去了，但命令还在跑；哨兵到了之后退出码落在
   * 这里，下一次 `wait` 立刻能取到——否则模型只能看到「exit 未知」，还得重跑一遍。
   */
  last: SessionWaitResult | null;
};

function tokenFor(counter: number): string {
  return `MICA_SSH_${counter}_${randomBytes(4).toString('hex')}`;
}

/** 一条命令 + 采集退出码；末尾的标记就是「这条命令说完了」。 */
export function wrapSessionCommand(command: string, token: string): string {
  return `${command.replace(/\n$/, '')}\n__mica_rc=$?\nprintf '\\036${token} %s\\036\\n' "$__mica_rc"\n`;
}

function sentinelPattern(token: string): RegExp {
  return new RegExp(`${MARK}${token} (-?\\d+)${MARK}\\n?`);
}

export class SessionManager {
  private readonly sessions = new Map<string, OpenSession>();
  private closing = false;

  constructor(private readonly ctx: RemoteContext) {}

  list(): SessionInfo[] {
    return [...this.sessions.values()].map((session) => ({
      id: session.id,
      hostId: session.host.id,
      target: `${session.host.user}@${session.host.host}:${session.host.port}`,
      cwd: session.cwd,
      createdAt: session.createdAt,
      lastUsedAt: session.lastUsedAt,
      running: session.waiter !== null,
      closed: session.closed,
    }));
  }

  get(id: string): OpenSession | null {
    const session = this.sessions.get(id);
    if (!session || session.closed) return null;
    return session;
  }

  async open(host: SshHost, options: { cwd?: string } = {}): Promise<{ info: SessionInfo; banner: string }> {
    if (this.closing) throw new Error('插件正在卸载，会话不再接受新命令');
    this.sweepIdle();
    const existing = this.get(host.id);
    if (existing) {
      return { info: this.list().find((entry) => entry.id === existing.id)!, banner: '' };
    }
    const password = host.auth === 'password' ? readPassword(host.id, this.ctx.dataDir) : null;
    if (host.auth === 'password' && !password) {
      throw new Error(`没有 ${host.id} 的口令：到 SSH 面板（或让用户）填一次密码。`);
    }
    const askpass = password ? createAskpass(password) : null;
    const args = buildSshArgs(this.ctx, host, { control: false, pty: true });
    const child = spawn(this.ctx.sshBinary, [...args, 'bash -l'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        ...(askpass ? { SSH_ASKPASS: askpass.path, SSH_ASKPASS_REQUIRE: 'force' } : {}),
      },
    }) as ChildProcessWithoutNullStreams;

    const session: OpenSession = {
      id: host.id,
      host,
      child,
      buffer: '',
      waiter: null,
      timer: null,
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
      cwd: options.cwd?.trim() || '~',
      closed: false,
      askpass,
      counter: 0,
      last: null,
    };
    this.sessions.set(host.id, session);

    const onData = (chunk: string): void => {
      session.buffer += chunk;
      this.flush(session);
    };
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.stdin.on('error', () => {
      // 连接断了时写 stdin 会 EPIPE；close 事件里统一报「会话已结束」。
    });
    const onClose = (): void => {
      if (session.closed) return;
      session.closed = true;
      this.sessions.delete(session.id);
      this.finish(session, { output: '', exitCode: null, timedOut: false, dead: true });
    };
    child.on('close', onClose);
    child.on('error', onClose);

    // PTY 的初始化：关回显与换行转换（否则每行输出都带 `\r`、输入也被回显回来），
    // 固定 200 列（默认 80 列会把日志与表格挤成很多行），清掉提示符。
    const banner = await this.run(
      host.id,
      'stty -echo -onlcr 2>/dev/null; stty cols 200 rows 40 2>/dev/null; export TERM=dumb GIT_PAGER=cat PAGER=cat PS1= PS2=',
      20_000,
    );
    if (banner.exitCode !== 0 || banner.dead) {
      this.close(host.id);
      throw new Error(banner.output.trim() || '持久会话没能建立（检查认证、以及远端是否有 bash）');
    }
    const cwd = options.cwd?.trim();
    if (cwd) {
      const moved = await this.run(host.id, `cd -- ${shellQuote(cwd)}`, 15_000);
      if (moved.exitCode !== 0) {
        this.close(host.id);
        throw new Error(moved.output.trim() || `进入目录失败：${cwd}`);
      }
      session.cwd = cwd;
    }
    return { info: this.list().find((entry) => entry.id === host.id)!, banner: banner.output.trim() };
  }

  /** 写一段命令并等它结束（最常见的一次调用）。 */
  async run(id: string, command: string, timeoutMs: number): Promise<SessionWaitResult> {
    const session = this.get(id);
    if (!session) return { output: '', exitCode: null, timedOut: false, dead: true };
    session.counter += 1;
    const token = tokenFor(session.counter);
    session.lastUsedAt = Date.now();
    const promise = this.arm(session, token, timeoutMs);
    try {
      session.child.stdin.write(wrapSessionCommand(command, token));
    } catch {
      return { output: '', exitCode: null, timedOut: false, dead: true };
    }
    return promise;
  }

  /** 只写不等待（长任务的第二步就是 `wait`），或者几步之后再回来收拾。 */
  write(id: string, command: string): { token: string } {
    const session = this.get(id);
    if (!session) throw new Error('会话不存在或已关闭');
    session.counter += 1;
    const token = tokenFor(session.counter);
    session.lastUsedAt = Date.now();
    this.arm(session, token, IDLE_CLOSE_MS);
    session.child.stdin.write(wrapSessionCommand(command, token));
    return { token };
  }

  /** 等当前这条命令结束；已经结束过就返回缓冲区里剩下的输出。 */
  async wait(id: string, timeoutMs: number): Promise<SessionWaitResult> {
    const session = this.get(id);
    if (!session) return { output: '', exitCode: null, timedOut: false, dead: true };
    if (!session.waiter) {
      const rest = session.buffer;
      session.buffer = '';
      const last = session.last;
      session.last = null;
      return { output: rest, exitCode: last?.exitCode ?? null, timedOut: false };
    }
    return new Promise((resolve) => {
      session.waiter!.resolvers.push(resolve);
      if (session.timer) clearTimeout(session.timer);
      session.timer = setTimeout(() => this.timeout(session), Math.max(1000, timeoutMs));
    });
  }

  /** 取走当前缓冲（不再等）。 */
  read(id: string): string {
    const session = this.get(id);
    if (!session) return '';
    const text = session.buffer;
    session.buffer = '';
    return text;
  }

  close(id: string): void {
    const session = this.sessions.get(id);
    if (!session) return;
    this.sessions.delete(id);
    session.closed = true;
    this.finish(session, { output: '', exitCode: null, timedOut: false, dead: true });
    this.teardown(session);
  }

  closeAll(): void {
    this.closing = true;
    for (const session of [...this.sessions.values()]) {
      this.sessions.delete(session.id);
      session.closed = true;
      this.finish(session, { output: '', exitCode: null, timedOut: false, dead: true });
      this.teardown(session);
    }
  }

  private teardown(session: OpenSession): void {
    if (session.timer) clearTimeout(session.timer);
    session.timer = null;
    try {
      session.child.stdin.end();
    } catch {
      // 已经关了
    }
    try {
      session.child.kill('SIGTERM');
    } catch {
      // 同上
    }
    disposeAskpass(session.askpass);
  }

  private sweepIdle(): void {
    const now = Date.now();
    for (const session of [...this.sessions.values()]) {
      if (!session.waiter && now - session.lastUsedAt > IDLE_CLOSE_MS) this.close(session.id);
    }
  }

  /** 挂一个等待者并起超时；数据可能比这里更早到，所以立刻扫一次缓冲。 */
  private arm(session: OpenSession, token: string, timeoutMs: number): Promise<SessionWaitResult> {
    // 上一条的超时等待者还挂着就把它的输出交给它，避免两条命令的输出混在一起。
    if (session.waiter) this.finish(session, { output: session.buffer, exitCode: null, timedOut: true });
    return new Promise((resolve) => {
      session.waiter = { token, resolvers: [resolve] };
      if (session.timer) clearTimeout(session.timer);
      session.timer = setTimeout(() => this.timeout(session), Math.max(1000, timeoutMs));
      this.flush(session);
    });
  }

  /** 超时：把已有输出交出去，但**不出队**——标记到了仍然要被吃掉，否则会污染下一条命令。 */
  private timeout(session: OpenSession): void {
    const output = session.buffer;
    session.buffer = '';
    session.timer = null;
    this.resolveAll(session, { output, exitCode: null, timedOut: true });
  }

  private flush(session: OpenSession): void {
    const waiter = session.waiter;
    if (!waiter) return;
    const match = sentinelPattern(waiter.token).exec(session.buffer);
    if (!match) return;
    // PTY 下正常的输出来自 `-onlcr` 关掉之后，理论上没有 `\r`；但程序自己的进度条
    // （`\r` 回到行首）会把一段文字搅在一起，去掉它至少还能读。
    const output = session.buffer.slice(0, match.index).replace(/\r/g, '');
    session.buffer = session.buffer.slice(match.index + match[0].length);
    this.finish(session, { output, exitCode: Number(match[1]), timedOut: false });
  }

  private finish(session: OpenSession, result: SessionWaitResult): void {
    if (!session.waiter) return;
    if (session.timer) clearTimeout(session.timer);
    session.timer = null;
    session.last = result;
    this.resolveAll(session, result);
    session.waiter = null;
  }

  private resolveAll(session: OpenSession, result: SessionWaitResult): void {
    const waiter = session.waiter;
    if (!waiter) return;
    const resolvers = waiter.resolvers;
    waiter.resolvers = [];
    for (const resolve of resolvers) resolve(result);
  }
}
