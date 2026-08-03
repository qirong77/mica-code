import { createWriteStream, type WriteStream } from 'node:fs';
import * as pty from 'node-pty';
import { stripAnsi } from './ansi.js';
import { ensureSpawnHelperExecutable } from './ensureExecutable.js';
import { KEYS, ctrl, type KeyName } from './keys.js';
import { toWellFormedText } from './wellFormedText.js';

export type PtySpawnOptions = {
  /** Terminal columns; default 120. */
  cols?: number;
  /** Terminal rows; default 40. */
  rows?: number;
  /** Working directory of the child process. */
  cwd?: string;
  /** Extra environment variables merged over `process.env`. */
  env?: Record<string, string>;
  /** TERM value; default `xterm-256color`. */
  name?: string;
  /** Append raw PTY output to this file. */
  logPath?: string;
  /** Append sent stdin bytes to this file; default `<logPath>.in`. */
  inputLogPath?: string;
};

export type WaitForOptions = {
  timeoutMs?: number;
  /** `text` (default) searches the full stripped output; `screen` searches the tail window. */
  mode?: 'text' | 'screen';
  /** Tail window size in characters for `screen` mode; default 80_000. */
  windowSize?: number;
};

export type TurnWaitOptions = {
  /** Regex of "active" status keywords (e.g. waiting_model/thinking/streaming). */
  activeRe?: RegExp;
  /** Regex of "done" status keywords (e.g. completed/error). */
  endRe?: RegExp;
  timeoutMs?: number;
  /** Give up as "none" if no active status appears within this window. */
  noActiveTimeoutMs?: number;
};

const DEFAULT_ACTIVE_RE = /thinking|streaming|calling_tool|waiting_model|running|working|subagent|compacting/;
const DEFAULT_TURN_ACTIVE_RE = /waiting_model|thinking|streaming|calling_tool/;
const DEFAULT_TURN_END_RE = /completed|error/;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** All match indices of a regex (adds the `g` flag on a clone to be safe). */
function matchIndices(text: string, rex: RegExp): number[] {
  const global = new RegExp(rex.source, rex.flags.includes('g') ? rex.flags : `${rex.flags}g`);
  const out: number[] = [];
  let m: RegExpExecArray | null;
  while ((m = global.exec(text)) !== null) {
    out.push(m.index);
    if (m.index === global.lastIndex) global.lastIndex++;
  }
  return out;
}

/**
 * A high-level driver around node-pty for driving interactive TUI programs in
 * tests and verification runs.
 *
 * - `onData` is async (node-pty reads the master fd off the JS thread), so the
 *   child never blocks on a full pty buffer and stdin bytes are never batched
 *   together (which previously corrupted Enter handling in a synchronous driver).
 * - Raw output and stripped text are both kept; `text()`/`latestScreen()`
 *   return ANSI-free views.
 * - Optional raw output + input echo logs.
 *
 * Run under Node (>=22) or vitest; node-pty is not compatible with the Bun
 * runtime itself (the master fd is invalid under Bun), so do not import this
 * package from code executed by Bun.
 */
export class PtyDriver {
  private readonly proc: pty.IPty;
  private readonly buffer = new BufferStore();
  private readonly outLog?: WriteStream;
  private readonly inputLog?: WriteStream;
  private readonly exitHandlers = new Set<(info: { exitCode: number; signal?: number }) => void>();
  private exited = false;
  private closed = false;

  private constructor(proc: pty.IPty, opts: Required<Pick<PtySpawnOptions, 'cols' | 'rows'>> & PtySpawnOptions) {
    this.proc = proc;
    proc.onData((data) => {
      this.buffer.append(data);
      this.outLog?.write(data);
    });
    proc.onExit((info) => {
      this.exited = true;
      for (const handler of this.exitHandlers) handler(info);
      this.exitHandlers.clear();
    });
    if (opts.logPath) {
      this.outLog = createWriteStream(opts.logPath, { flags: 'a' });
      this.inputLog = createWriteStream(opts.inputLogPath ?? `${opts.logPath}.in`, { flags: 'a' });
    }
  }

  /** Spawn a program under a fresh PTY. */
  static spawn(argv: string[], options: PtySpawnOptions = {}): PtyDriver {
    ensureSpawnHelperExecutable();
    if (argv.length === 0) throw new Error('spawn() requires a non-empty argv');
    const [file, ...args] = argv;
    const cols = options.cols ?? 120;
    const rows = options.rows ?? 40;
    const name = options.name ?? 'xterm-256color';
    const env = {
      ...process.env,
      TERM: name,
      COLUMNS: String(cols),
      LINES: String(rows),
      ...options.env,
    };
    const proc = pty.spawn(file, args, { name, cols, rows, cwd: options.cwd, env });
    return new PtyDriver(proc, { ...options, cols, rows });
  }

  get pid(): number {
    return this.proc.pid;
  }

  get isExited(): boolean {
    return this.exited;
  }

  /** Bytes of raw output captured so far. */
  get rawLength(): number {
    return this.buffer.length;
  }

  /** Write raw bytes to the child's stdin. */
  send(data: string): void {
    if (this.closed || this.exited) return;
    this.inputLog?.write(`>>> ${JSON.stringify(data)}\n`);
    try {
      this.proc.write(data);
    } catch {
      // Process already gone; ignore.
    }
  }

  /** Type text character-by-character (slow, human-like input). */
  async typeText(text: string, charDelayMs = 12): Promise<void> {
    for (const char of text) {
      this.send(char);
      if (charDelayMs > 0) await sleep(charDelayMs);
    }
  }

  /** Send a named key sequence (enter/esc/tab/arrows/ctrl-...). */
  sendKey(name: KeyName): void {
    this.send(KEYS[name]);
  }

  /** Send a Ctrl+<letter> sequence. */
  sendCtrl(letter: string): void {
    this.send(ctrl(letter));
  }

  enter(): void {
    this.sendKey('enter');
  }

  esc(): void {
    this.sendKey('esc');
  }

  /** Resize the PTY window. */
  resize(cols: number, rows: number): void {
    this.proc.resize(cols, rows);
  }

  /** Full raw output (with ANSI sequences). */
  raw(): string {
    return this.buffer.toString();
  }

  /** Full output with ANSI/control sequences stripped. */
  text(): string {
    return this.buffer.stripped();
  }

  /** Tail window of stripped output; matches the recent visible screen. */
  latestScreen(windowSize = 80_000): string {
    return this.buffer.strippedWindow(windowSize);
  }

  /** Subscribe to output chunks; returns an unsubscribe function. */
  onData(cb: (data: string) => void): () => void {
    return this.buffer.subscribe(cb);
  }

  /** Subscribe to process exit; returns an unsubscribe function. */
  onExit(cb: (info: { exitCode: number; signal?: number }) => void): () => void {
    if (this.exited) {
      cb({ exitCode: 0, signal: undefined });
      return () => undefined;
    }
    this.exitHandlers.add(cb);
    return () => this.exitHandlers.delete(cb);
  }

  /** Wait for output matching a pattern. Returns false on timeout. */
  async waitFor(pattern: string | RegExp, options: WaitForOptions = {}): Promise<boolean> {
    const rex = typeof pattern === 'string' ? new RegExp(pattern, 's') : pattern;
    const timeoutMs = options.timeoutMs ?? 30_000;
    const windowSize = options.windowSize ?? 80_000;
    const source = () => (options.mode === 'screen' ? this.latestScreen(windowSize) : this.text());
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (testWithReset(rex, source())) return true;
      await sleep(100);
    }
    return testWithReset(rex, source());
  }

  /** Wait until no new output arrives for `minIdleMs`. Returns false on overall timeout. */
  async waitIdle(minIdleMs = 400, timeoutMs = 30_000): Promise<boolean> {
    const start = Date.now();
    let lastLen = this.buffer.length;
    let lastChange = start;
    while (Date.now() - lastChange < minIdleMs) {
      if (Date.now() - start > timeoutMs) return false;
      if (this.buffer.length !== lastLen) {
        lastLen = this.buffer.length;
        lastChange = Date.now();
      }
      await sleep(20);
    }
    return true;
  }

  /**
   * Wait until a NEW turn completes after `sendTextPos` (a character offset into
   * `text()` taken before sending the input). A turn is "active" when an active
   * status keyword appears after `sendTextPos`, and "completed" when a done
   * keyword appears after that. Mirrors the mica TUI status line.
   *
   * Returns "completed", "none" (no active status within noActiveTimeoutMs) or
   * "timeout".
   */
  async waitTurnCompleted(
    sendTextPos: number,
    options: TurnWaitOptions = {},
  ): Promise<'completed' | 'none' | 'timeout'> {
    const activeRe = options.activeRe ?? DEFAULT_TURN_ACTIVE_RE;
    const endRe = options.endRe ?? DEFAULT_TURN_END_RE;
    const timeoutMs = options.timeoutMs ?? 240_000;
    const noActiveTimeoutMs = options.noActiveTimeoutMs ?? 20_000;
    const start = Date.now();
    let sawActive = false;
    let activeSince = 0;
    while (Date.now() - start < timeoutMs) {
      const text = this.text();
      const acts = matchIndices(text, activeRe);
      const comps = matchIndices(text, endRe);
      const lastActive = acts.length > 0 ? Math.max(...acts) : -1;
      const lastComp = comps.length > 0 ? Math.max(...comps) : -1;
      if (lastComp > Math.max(sendTextPos, lastActive)) return 'completed';
      const now = Date.now();
      if (!sawActive && lastActive > sendTextPos) {
        sawActive = true;
        activeSince = now;
      }
      if (sawActive && now - activeSince > 60_000) activeSince = now;
      if (!sawActive && now - start > noActiveTimeoutMs) return 'none';
      await sleep(50);
    }
    return 'timeout';
  }

  /** Whether the last-observed output shows an active (busy) status keyword. */
  isActive(): boolean {
    return DEFAULT_ACTIVE_RE.test(this.text());
  }

  /**
   * Kill the child and close logs. `signal` defaults to SIGTERM; if the process
   * has not exited within `forceAfterMs` it is escalated to SIGKILL.
   */
  async close(signal: string = 'SIGTERM', forceAfterMs = 3_000): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (!this.exited) {
      const exited = new Promise<void>((resolve) => this.onExit(() => resolve()));
      try {
        this.proc.kill(signal);
      } catch {
        // Already gone.
      }
      await Promise.race([exited, sleep(forceAfterMs)]);
      if (!this.exited) {
        try {
          this.proc.kill('SIGKILL');
        } catch {
          // Ignore.
        }
      }
    }
    this.outLog?.close();
    this.inputLog?.close();
  }
}

function testWithReset(rex: RegExp, text: string): boolean {
  if (rex.global || rex.sticky) rex.lastIndex = 0;
  return rex.test(text);
}

/** Accumulates raw output and lazily computes stripped views. */
class BufferStore {
  private chunks: string[] = [];
  private total = 0;
  private strippedCache = '';
  private dirty = true;
  private readonly listeners = new Set<(data: string) => void>();

  append(data: string): void {
    this.chunks.push(data);
    this.total += data.length;
    this.dirty = true;
    for (const listener of this.listeners) listener(data);
  }

  get length(): number {
    return this.total;
  }

  toString(): string {
    return this.chunks.join('');
  }

  stripped(): string {
    if (this.dirty) {
      this.strippedCache = toWellFormedText(stripAnsi(this.chunks.join('')));
      this.dirty = false;
    }
    return this.strippedCache;
  }

  strippedWindow(windowSize: number): string {
    const all = this.chunks.join('');
    const slice = all.length > windowSize ? all.slice(-windowSize) : all;
    return toWellFormedText(stripAnsi(slice));
  }

  subscribe(cb: (data: string) => void): () => void {
    // Replay existing chunks, then attach to future appends.
    for (const chunk of this.chunks) cb(chunk);
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }
}
