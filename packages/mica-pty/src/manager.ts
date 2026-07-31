import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { stripAnsi } from './ansi.js';
import { KEYS, type KeyName } from './keys.js';
import { ptyServerSource } from './ptyServerSource.js';

/**
 * Bun-side PTY session manager.
 *
 * node-pty's native binding is inert under Bun (spawned PTY processes never
 * deliver output), so the actual PTY lifecycle runs in a Node child process
 * (`packages/mica-pty/src/server.mjs`) speaking JSONL over stdio. This module
 * is Bun-safe: it never imports node-pty itself, only stdio/IPC primitives.
 *
 * Sessions are lazily started and shared across the process; the helper stays
 * alive until every session is gone or the host exits.
 */

export const MAX_PTY_OUTPUT_BYTES = 4 * 1024 * 1024;
const SESSION_ID_PATTERN = /^[a-f0-9]{12}$/;
const DEFAULT_READ_WINDOW = 80_000;

export type PtySpawnOptions = {
  cols?: number;
  rows?: number;
  cwd?: string;
  env?: Record<string, string>;
  name?: string;
};

export type PtyReadOptions = {
  /** `all` (default) returns everything captured; `tail` returns the trailing window. */
  mode?: 'all' | 'tail';
  windowSize?: number;
  /** Default true: ANSI/control sequences are stripped before returning. */
  stripAnsi?: boolean;
  /** Clear the captured buffer after reading. */
  clear?: boolean;
};

export type PtyWaitOptions = {
  /** Regex pattern to wait for; resolves as soon as it appears. */
  pattern?: string;
  timeoutMs?: number;
  /** If set, resolves once no new output arrives for this many ms. */
  idleMs?: number;
  windowSize?: number;
};

export type PtyReadResult = {
  output: string;
  totalBytes: number;
  exited: boolean;
  exitCode: number | null;
  signal: string | null;
};

export type PtyWaitResult = {
  matched: boolean;
  reason: 'pattern' | 'idle' | 'exited' | 'timeout';
  exited: boolean;
  output: string;
  totalBytes: number;
};

export type PtySessionInfo = {
  id: string;
  pid?: number;
  exited: boolean;
  exitCode: number | null;
  signal: string | null;
  totalBytes: number;
  startedAt: number;
};

class PtySession {
  readonly id: string;
  readonly startedAt = Date.now();
  pid?: number;
  exited = false;
  exitCode: number | null = null;
  signal: string | null = null;
  private chunks: string[] = [];
  totalBytes = 0;

  constructor(id: string) {
    this.id = id;
  }

  append(data: string): void {
    this.totalBytes += data.length;
    this.chunks.push(data);
    // Drop the head when the buffer grows beyond the cap so long-running
    // sessions cannot leak memory indefinitely.
    if (this.totalBytes > MAX_PTY_OUTPUT_BYTES) {
      const over = this.totalBytes - MAX_PTY_OUTPUT_BYTES;
      let dropped = 0;
      while (this.chunks.length > 1 && dropped < over) {
        dropped += this.chunks[0].length;
        this.chunks.shift();
      }
      this.totalBytes = this.chunks.reduce((sum, c) => sum + c.length, 0);
    }
  }

  clear(): void {
    this.chunks = [];
    this.totalBytes = 0;
  }

  allText(strip: boolean, windowSize?: number): string {
    const joined = this.chunks.join('');
    const sliced = windowSize && joined.length > windowSize ? joined.slice(-windowSize) : joined;
    return strip ? stripAnsi(sliced) : sliced;
  }
}

type PendingRequest = {
  resolve: (msg: HelperReply) => void;
  timer?: ReturnType<typeof setTimeout>;
};

type HelperReply = {
  id: number;
  ok: boolean;
  error?: string;
  session?: string;
  pid?: number;
  sessions?: string[];
  alreadyGone?: boolean;
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function assertSafeSessionId(id: string): void {
  if (!SESSION_ID_PATTERN.test(id)) {
    throw new Error(`无效 session_id: ${id}`);
  }
}

/** Resolve the node-pty module entry the helper should load. */
async function resolveNodePtyEntry(): Promise<string> {
  try {
    return await import.meta.resolve('node-pty');
  } catch {
    // Fall back to a plain node_modules lookup from the current directory.
    const fromCwd = path.join(process.cwd(), 'node_modules', 'node-pty', 'lib', 'index.js');
    if (existsSync(fromCwd)) return pathToFileURL(fromCwd).href;
  }
  throw new Error(
    '未找到 node-pty 依赖。PTY 工具需要本机可用的 node-pty（开发环境已在 node_modules 内置），' +
      '且 Node >= 22 可执行文件位于 PATH（可用 MICA_PTY_NODE 覆盖）。',
  );
}

export class PtyManager {
  private helper: ChildProcess | null = null;
  private startupPromise: Promise<void> | null = null;
  private sessions = new Map<string, PtySession>();
  private pending = new Map<number, PendingRequest>();
  private seq = 0;
  private tempDir: string | null = null;
  private exitCleanupRegistered = false;

  /** Number of live sessions. */
  get sessionCount(): number {
    return this.sessions.size;
  }

  list(): PtySessionInfo[] {
    return [...this.sessions.values()].map((s) => this.toInfo(s));
  }

  /** Launch the Node helper lazily; concurrent callers share one startup. */
  ensureStarted(): Promise<void> {
    if (!this.startupPromise) {
      this.startupPromise = this.startHelper().catch((error) => {
        this.startupPromise = null;
        throw error;
      });
    }
    return this.startupPromise;
  }

  async spawn(argv: string[], options: PtySpawnOptions = {}): Promise<{ sessionId: string; pid: number }> {
    if (!Array.isArray(argv) || argv.length === 0) {
      throw new Error('spawn 需要非空 argv');
    }
    await this.ensureStarted();
    const reply = await this.request({ type: 'spawn', argv, options });
    if (!reply.ok || !reply.session) throw new Error(reply.error ?? 'PTY spawn 失败');
    const session = new PtySession(reply.session);
    session.pid = reply.pid;
    this.sessions.set(session.id, session);
    return { sessionId: session.id, pid: reply.pid ?? -1 };
  }

  /** Send raw bytes (or a named key) to the PTY master. */
  send(sessionId: string, data: string): Promise<void> {
    return this.sendRaw(sessionId, data);
  }

  /** Send a named key sequence, e.g. `enter`, `esc`, `ctrlC`. */
  async sendKey(sessionId: string, keyName: string): Promise<void> {
    if (!(keyName in KEYS)) {
      throw new Error(`未知按键: ${keyName}（可用: ${Object.keys(KEYS).join(', ')}）`);
    }
    await this.sendRaw(sessionId, KEYS[keyName as KeyName]);
  }

  private async sendRaw(sessionId: string, data: string): Promise<void> {
    assertSafeSessionId(sessionId);
    if (!this.sessions.has(sessionId)) throw new Error(`session 不存在或已结束: ${sessionId}`);
    await this.ensureStarted();
    const reply = await this.request({ type: 'send', session: sessionId, data });
    if (!reply.ok) throw new Error(reply.error ?? 'PTY send 失败');
  }

  async resize(sessionId: string, cols: number, rows: number): Promise<void> {
    assertSafeSessionId(sessionId);
    if (!this.sessions.has(sessionId)) throw new Error(`session 不存在或已结束: ${sessionId}`);
    await this.ensureStarted();
    const reply = await this.request({ type: 'resize', session: sessionId, cols, rows });
    if (!reply.ok) throw new Error(reply.error ?? 'PTY resize 失败');
  }

  read(sessionId: string, options: PtyReadOptions = {}): PtyReadResult {
    const session = this.getSession(sessionId);
    const windowSize = options.windowSize ?? DEFAULT_READ_WINDOW;
    const output =
      options.mode === 'tail'
        ? session.allText(options.stripAnsi !== false, windowSize)
        : session.allText(options.stripAnsi !== false, undefined);
    if (options.clear) session.clear();
    return {
      output,
      totalBytes: session.totalBytes,
      exited: session.exited,
      exitCode: session.exitCode,
      signal: session.signal,
    };
  }

  async wait(sessionId: string, options: PtyWaitOptions = {}): Promise<PtyWaitResult> {
    const session = this.getSession(sessionId);
    const pattern = options.pattern ? new RegExp(options.pattern, 's') : null;
    const timeoutMs = options.timeoutMs ?? 30_000;
    const idleMs = options.idleMs ?? 0;
    const deadline = Date.now() + timeoutMs;
    let lastLen = -1;
    let lastChange = Date.now();
    const snapshot = (): { output: string; totalBytes: number; exited: boolean } => ({
      output: session.allText(true, options.windowSize ?? DEFAULT_READ_WINDOW),
      totalBytes: session.totalBytes,
      exited: session.exited,
    });
    while (Date.now() < deadline) {
      const current = snapshot();
      if (current.totalBytes !== lastLen) {
        lastLen = current.totalBytes;
        lastChange = Date.now();
      }
      if (pattern && pattern.test(current.output)) {
        return { ...current, matched: true, reason: 'pattern' };
      }
      if (current.exited) {
        return { ...current, matched: false, reason: 'exited' };
      }
      if (idleMs > 0 && Date.now() - lastChange >= idleMs) {
        return { ...current, matched: false, reason: 'idle' };
      }
      await sleep(50);
    }
    const final = snapshot();
    return { ...final, matched: pattern ? pattern.test(final.output) : false, reason: 'timeout' };
  }

  /** Kill the child process of a session; escalated to SIGKILL after forceAfterMs. */
  async kill(sessionId: string, signal = 'SIGTERM', forceAfterMs = 3_000): Promise<void> {
    assertSafeSessionId(sessionId);
    if (!this.sessions.has(sessionId)) return;
    await this.ensureStarted();
    const reply = await this.request({ type: 'close', session: sessionId, signal, forceAfterMs });
    if (!reply.ok) throw new Error(reply.error ?? 'PTY kill 失败');
  }

  /** Terminate the helper and all remaining sessions. */
  async shutdown(): Promise<void> {
    const helper = this.helper;
    if (!helper || helper.killed || !helper.stdin) return;
    try {
      helper.stdin.end();
    } catch {
      // Ignore.
    }
    if (helper.exitCode === null) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 2_000);
        helper.once('exit', () => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
    if (!helper.killed) {
      try {
        helper.kill('SIGTERM');
      } catch {
        // Ignore.
      }
    }
    // The helper killed every remaining child on EOF; drop their records.
    this.sessions.clear();
  }

  private getSession(sessionId: string): PtySession {
    assertSafeSessionId(sessionId);
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`session 不存在或已结束: ${sessionId}`);
    return session;
  }

  private toInfo(session: PtySession): PtySessionInfo {
    return {
      id: session.id,
      pid: session.pid,
      exited: session.exited,
      exitCode: session.exitCode,
      signal: session.signal,
      totalBytes: session.totalBytes,
      startedAt: session.startedAt,
    };
  }

  private async startHelper(): Promise<void> {
    if (this.helper && !this.helper.killed) return;
    const ptyEntry = await resolveNodePtyEntry();

    // Materialize the server script in a temp dir; stdin/stdout are reserved
    // for the JSONL protocol, so the script cannot be piped via stdin.
    const dir = mkdtempSync(path.join(tmpdir(), 'mica-pty-'));
    const serverPath = path.join(dir, 'server.mjs');
    writeFileSync(serverPath, ptyServerSource, 'utf-8');
    this.tempDir = dir;

    const nodeBin = process.env.MICA_PTY_NODE ?? 'node';
    const child = spawn(nodeBin, [serverPath], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, MICA_PTY_ENTRY: ptyEntry },
    });
    this.helper = child;

    child.stdout.setEncoding('utf-8');
    let lineBuffer = '';
    child.stdout.on('data', (chunk: string) => {
      lineBuffer += chunk;
      let nl: number;
      while ((nl = lineBuffer.indexOf('\n')) !== -1) {
        const line = lineBuffer.slice(0, nl);
        lineBuffer = lineBuffer.slice(nl + 1);
        this.handleHelperLine(line);
      }
    });
    child.stderr.setEncoding('utf-8');
    child.stderr.on('data', (chunk: string) => {
      process.stderr.write(`[mica-pty-helper] ${chunk}`);
    });
    child.on('error', (error) => {
      this.startupPromise = null;
      this.rejectAllPending(error);
      if (this.helper === child) this.helper = null;
    });
    child.on('exit', (code, signal) => {
      if (this.helper === child) this.helper = null;
      const exitError = new Error(`PTY helper 进程退出 (code=${code}, signal=${signal ?? 'none'})`);
      this.rejectAllPending(exitError);
      for (const session of this.sessions.values()) {
        if (!session.exited) {
          session.exited = true;
          session.exitCode = code;
          session.signal = signal ? String(signal) : 'killed';
        }
      }
      this.cleanupTemp();
    });
    this.registerExitCleanup();
  }

  private handleHelperLine(line: string): void {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    if (typeof msg.id === 'number') {
      const pending = this.pending.get(msg.id);
      if (pending) {
        this.pending.delete(msg.id);
        if (pending.timer) clearTimeout(pending.timer);
        pending.resolve(msg as unknown as HelperReply);
      }
      return;
    }
    if (msg.type === 'data' && typeof msg.session === 'string') {
      const session = this.sessions.get(msg.session);
      if (session && typeof msg.data === 'string') session.append(msg.data);
      return;
    }
    if (msg.type === 'exit' && typeof msg.session === 'string') {
      const session = this.sessions.get(msg.session);
      if (session) {
        session.exited = true;
        session.exitCode = typeof msg.exitCode === 'number' ? msg.exitCode : null;
        session.signal = typeof msg.signal === 'number' && msg.signal !== 0 ? String(msg.signal) : null;
      }
      return;
    }
  }

  private request(payload: Record<string, unknown>): Promise<HelperReply> {
    const id = ++this.seq;
    const msgType = String(payload.type ?? 'unknown');
    const message = { id, ...payload };
    const helper = this.helper;
    if (!helper || helper.killed || !helper.stdin || !helper.stdin.writable) {
      return Promise.reject(new Error('PTY helper 进程不可用'));
    }
    const stdin = helper.stdin;
    return new Promise<HelperReply>((resolve, reject) => {
      const entry: PendingRequest = { resolve };
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`PTY helper 响应超时 (${msgType})`));
      }, 15_000);
      entry.timer = timer;
      this.pending.set(id, entry);
      try {
        stdin.write(`${JSON.stringify(message)}\n`);
      } catch (error) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(error);
      }
    });
  }

  private rejectAllPending(error: Error): void {
    for (const pending of this.pending.values()) {
      if (pending.timer) clearTimeout(pending.timer);
      pending.resolve({ id: -1, ok: false, error: error.message });
    }
    this.pending.clear();
  }

  private cleanupTemp(): void {
    if (this.tempDir) {
      try {
        rmSync(this.tempDir, { recursive: true, force: true });
      } catch {
        // Ignore.
      }
      this.tempDir = null;
    }
  }

  private registerExitCleanup(): void {
    if (this.exitCleanupRegistered) return;
    this.exitCleanupRegistered = true;
    const cleanup = () => {
      const helper = this.helper;
      if (helper && !helper.killed) {
        try {
          helper.kill('SIGTERM');
        } catch {
          // Ignore.
        }
      }
      this.cleanupTemp();
    };
    process.once('exit', cleanup);
    // Do not hang on an uninterruptible helper during process teardown.
    process.once('SIGTERM', () => cleanup());
    process.once('SIGINT', () => cleanup());
  }
}

/** Process-wide shared manager (single Node helper for all sessions). */
export const ptyManager = new PtyManager();
