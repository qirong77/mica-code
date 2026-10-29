import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, isAbsolute, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { SidecarTranscript } from './transcript.js';

/**
 * 一个子会话 = 一个常驻的 `mica app-server` 进程。
 *
 * 为什么不是 HTTP 或浏览器：`mica app-server` 是这个会话自己的宿主，事件是结构化的
 * Codex v2 JSONL（正文 delta、工具调用与结果、用量、轮次终态），一条连接就拿到全部进度；
 * 而驱动界面要点 UI、读 DOM，一次观测要几十个回合，界面一改就碎。桌面端能从侧栏看到
 * 这个会话，是因为它把自己的会话文件写在 `$MICA_HOME/sessions/` 下——不需要任何界面操作。
 */

export type SidecarCliCommand = { command: string; prefixArgs: string[] };

/**
 * 重新拼出「启动当前这个 CLI」的命令。
 *
 * 生产环境是单二进制（`process.execPath` 就是 mica）；dev / 测试下 `bun` 或 `node`
 * 跑的是入口脚本，此时必须把入口一起带上，否则子进程会去执行一个不存在的默认入口。
 */
export function resolveCliCommand(): SidecarCliCommand {
  const runtimeHost = /^(bun|node)(\.exe)?$/i.test(basename(process.execPath));
  const entry = process.argv[1] ?? '';
  if (runtimeHost && entry && !entry.startsWith('/$bunfs')) {
    return { command: process.execPath, prefixArgs: [entry] };
  }
  return { command: process.execPath, prefixArgs: [] };
}

export type SidecarProcessOptions = {
  /** 子会话的工作目录；缺省与父会话相同。 */
  cwd?: string;
  model?: string;
  effort?: string;
  role?: string;
  /** 父会话 id：写进会话文件，侧栏据此把子会话嵌套在父会话下面。 */
  parentSessionId?: string;
  maxTurns?: number;
  /** 显式指定启动命令（测试与探针用）；缺省按当前进程重建 CLI 命令。 */
  launch?: SidecarCliCommand;
};

/**
 * 把子会话的工作目录规范成绝对路径。
 *
 * **必须是绝对路径**：这个值同时用作子进程的 `cwd` 和 `--dir` 参数，而子进程启动之后
 * `--dir` 是相对**它自己**的 cwd 解析的。传相对路径会解析两次（`/repo` + `api` 变成
 * `/repo/api/api`），子会话直接 chdir 失败。
 */
export function resolveSessionCwd(cwd?: string): string {
  const raw = cwd?.trim();
  if (!raw) return process.cwd();
  const expanded = raw === '~' ? homedir() : raw.startsWith('~/') ? join(homedir(), raw.slice(2)) : raw;
  return isAbsolute(expanded) ? resolve(expanded) : resolve(process.cwd(), expanded);
}

/**
 * 在起进程之前就把「目录不能用」检出来。
 *
 * 不检的话 `spawn` 会失败在 cwd 上，而报出来的是 `ENOENT ... posix_spawn 'mica'`——
 * 一眼看过去像可执行文件不存在，实际是工作目录写错了。
 */
function assertUsableCwd(cwd: string): void {
  if (!existsSync(cwd)) throw new Error(`工作目录不存在：${cwd}`);
  if (!statSync(cwd).isDirectory()) throw new Error(`工作目录不是目录：${cwd}`);
}

type PendingRequest = {
  resolve: (value: Record<string, unknown>) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
};

/** 协议请求的等待上限：initialize/thread/start 是本地握手，turn/start 只是入队。 */
const REQUEST_TIMEOUT_MS = 30_000;
const STDERR_TAIL = 4_000;

export class SidecarProcess {
  readonly transcript = new SidecarTranscript();
  /** `thread/start` 之后才有：子会话的会话 id。 */
  sessionId: string | null = null;
  closed = false;

  private readonly child: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<number, PendingRequest>();
  private nextRequestId = 1;
  private stderrTail = '';
  private exitReason = '';
  private waiters = new Set<() => void>();

  private constructor(
    child: ChildProcessWithoutNullStreams,
    private readonly options: SidecarProcessOptions,
    private readonly launched: string,
  ) {
    this.child = child;
    this.attach();
  }

  /** 起一个 app-server 进程并完成握手（initialize + thread/start）。 */
  static async start(
    options: SidecarProcessOptions,
    cli = options.launch ?? resolveCliCommand(),
  ): Promise<SidecarProcess> {
    // 解析成绝对路径再往下传：同一个值要用作子进程 cwd 和 --dir，相对路径会被解析两次。
    const cwd = resolveSessionCwd(options.cwd);
    assertUsableCwd(cwd);
    const args = [...cli.prefixArgs, 'app-server', '--thinking', '--dir', cwd];
    if (options.model) args.push('--model', options.model);
    if (options.effort) args.push('--variant', options.effort);
    if (options.role) args.push('--role', options.role);
    if (options.parentSessionId) args.push('--parent', options.parentSessionId);
    if (typeof options.maxTurns === 'number' && options.maxTurns > 0)
      args.push('--max-turns', String(options.maxTurns));

    const env: NodeJS.ProcessEnv = { ...process.env };
    // 子会话是纯 headless 宿主：它没有界面，「桌面端才有的能力面」不该被假装提供。
    delete env.MICA_PLUGIN_DESKTOP_HOST;

    const child = spawn(cli.command, args, {
      cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const process_ = new SidecarProcess(child, { ...options, cwd }, [cli.command, ...args].join(' '));
    await process_.handshake();
    return process_;
  }

  /** 给失败信息用的命令摘要：超时多半是启动命令不对，而不是子进程慢。 */
  private describeLaunched(): string {
    const stderr = this.stderrTail.trim();
    return `启动命令：${this.launched}；stderr：${stderr ? stderr.slice(-400) : '(空)'}`;
  }

  private attach(): void {
    const lines = createInterface({ input: this.child.stdout });
    lines.on('line', (line) => this.onLine(line));
    this.child.stderr.on('data', (chunk: Buffer) => {
      this.stderrTail = `${this.stderrTail}${chunk.toString('utf8')}`.slice(-STDERR_TAIL);
    });
    this.child.on('error', (error) => this.onExit(`无法启动 mica app-server：${error.message}`));
    this.child.on('close', (code, signal) => {
      this.onExit(`mica app-server 已退出（${signal || `code ${code}`}）`);
    });
  }

  private async handshake(): Promise<void> {
    await this.request('initialize', { clientInfo: { name: 'sidecar', version: '1.0.0' } });
    this.write({ method: 'initialized', params: {} });
    const result = await this.request('thread/start', {
      cwd: this.options.cwd,
      ...(this.options.model ? { model: this.options.model } : {}),
      ...(this.options.effort ? { effort: this.options.effort } : {}),
      ...(this.options.parentSessionId ? { parentSessionId: this.options.parentSessionId } : {}),
    });
    const thread = result.thread;
    if (thread && typeof thread === 'object' && typeof (thread as { id?: unknown }).id === 'string') {
      this.sessionId = (thread as { id: string }).id;
    }
  }

  get threadId(): string {
    return this.sessionId ?? '';
  }

  /** 规范成绝对路径之后的工作目录（`start` 里已经解析过）。 */
  get cwd(): string {
    return this.options.cwd ?? process.cwd();
  }

  /** 投一句新的话。宿主忙时会走 `turn/steer`（迭代边界注入），与用户按回车一致。 */
  async send(text: string): Promise<{ queued: boolean }> {
    if (this.closed) throw new Error('子会话已关闭');
    const prompt = text.trim();
    if (!prompt) throw new Error('消息内容为空');
    const input = [{ type: 'text', text: prompt }];
    const activeTurnId = this.transcript.activeTurnId;
    // 先记录再发：`turn/started` 可能比响应先到，事后补记会挂到下一轮去。
    const token = this.transcript.recordUserInput(prompt);
    try {
      if (activeTurnId) {
        await this.request('turn/steer', {
          threadId: this.threadId,
          expectedTurnId: activeTurnId,
          input,
        });
        return { queued: true };
      }
      await this.request('turn/start', {
        threadId: this.threadId,
        input,
        ...(this.options.cwd ? { cwd: this.options.cwd } : {}),
      });
      return { queued: false };
    } catch (error) {
      this.transcript.dropUserInput(token);
      throw error;
    }
  }

  /** 中断当前这一轮（不影响进程与会话，之后还能继续发）。 */
  async abort(): Promise<boolean> {
    if (this.closed) return false;
    const turnId = this.transcript.activeTurnId;
    if (!turnId) return false;
    await this.request('turn/interrupt', { threadId: this.threadId, turnId });
    return true;
  }

  /**
   * 收起进程：先关 stdin（宿主据此正常退出并落盘），超时再杀。
   *
   * 不能一上来就 SIGTERM：那一轮的回答与 `completed` 状态会一起丢，用户看到的
   * 就是一条永远 running 的会话。
   */
  async close(graceMs = 3_000): Promise<void> {
    if (this.closed) return;
    const exited = new Promise<void>((resolve) => {
      if (this.closed) return resolve();
      this.waiters.add(resolve);
    });
    try {
      this.child.stdin.end();
    } catch {
      // stdin 可能已经关了，下面等退出即可。
    }
    const timeout = new Promise<void>((resolve) => setTimeout(resolve, graceMs));
    await Promise.race([exited, timeout]);
    if (!this.closed) {
      try {
        this.child.kill('SIGTERM');
      } catch {
        // 进程可能刚好已经退出。
      }
    }
  }

  /** 等一次可见变化（或超时）。等待类工具靠它避免忙轮询。 */
  waitForChange(timeoutMs: number): Promise<boolean> {
    if (this.closed) return Promise.resolve(false);
    return new Promise((resolve) => {
      let settled = false;
      const done = (changed: boolean) => {
        if (settled) return;
        settled = true;
        this.waiters.delete(notify);
        clearTimeout(timer);
        resolve(changed);
      };
      const notify = () => done(true);
      const timer = setTimeout(() => done(false), Math.max(0, timeoutMs));
      this.waiters.add(notify);
    });
  }

  private request(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (this.closed) return Promise.reject(new Error(this.exitReason || '子会话已关闭'));
    const id = this.nextRequestId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        // 把实际起的命令带上：这个超时最常见的原因不是慢，而是启动命令本身错了
        // （例如宿主进程的 argv[1] 不是 mica 入口），光说「无响应」查不出来。
        const detail = this.closed ? this.exitReason : this.describeLaunched();
        reject(new Error(`${method} 超时（${REQUEST_TIMEOUT_MS}ms 无响应）—— ${detail}`));
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.write({ id, method, params });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  private write(message: Record<string, unknown>): void {
    if (this.closed) throw new Error(this.exitReason || '子会话已关闭');
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private onLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      // stdout 只该有协议行；非 JSON 一律当诊断信息，留在 stderr 尾部类似的位置。
      this.stderrTail = `${this.stderrTail}\n${trimmed}`.slice(-STDERR_TAIL);
      return;
    }

    if (typeof message.id === 'number' && !('method' in message)) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      const error = message.error;
      if (error && typeof error === 'object') {
        const text = (error as { message?: unknown }).message;
        pending.reject(new Error(typeof text === 'string' && text ? text : 'app-server 返回错误'));
        return;
      }
      const result = message.result;
      pending.resolve(result && typeof result === 'object' ? (result as Record<string, unknown>) : {});
      return;
    }

    if (typeof message.method === 'string') {
      const changed = this.transcript.apply(message);
      if (changed) this.notify();
    }
  }

  private notify(): void {
    for (const waiter of [...this.waiters]) waiter();
  }

  private onExit(reason: string): void {
    if (this.closed) return;
    this.closed = true;
    this.exitReason = reason;
    this.transcript.abort('interrupted', reason);
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      this.pending.delete(id);
      pending.reject(new Error(this.describeFailure(reason)));
    }
    this.notify();
  }

  /** 进程挂掉时的可读原因：stderr 的最后几行通常就是真正的失败原因。 */
  describeFailure(reason = this.exitReason): string {
    const tail = this.stderrTail.trim().split('\n').slice(-6).join('\n');
    return tail ? `${reason}\n${tail}` : reason;
  }
}
