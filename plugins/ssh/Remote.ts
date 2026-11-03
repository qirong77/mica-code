import { execFileSync, spawn } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SshHost } from './Hosts.js';
import { readPassword, hasStoredPassword } from './Secrets.js';

/**
 * 远程执行引擎：一次调用 = 一个本地 `ssh` 子进程。
 *
 * 这一层要同时解决三件事，任何一件做错都会让「模型操作服务器」变成又慢又危险：
 *
 * 1. **连接复用**。`ControlMaster=auto` + `ControlPersist`：第一次握手后把连接留给后续
 *    调用，同一台机器的第 2 条命令只付 RTT，不付 TLS/认证的时间。
 * 2. **输出预算**。远程 shell 的输出经常上万行（`make`、`docker logs`），一次塞进上下文
 *    会让**之后每一轮**都重发它。所以只保留尾部 N 行，全文留在远端 `/tmp` 并告诉模型
 *    路径——要看细节让它自己 `tail`/`grep`，别一次性搬进对话。
 * 3. **凭证不出本进程**。口令从 Keychain 取，经 0700 的 askpass 脚本喂给 ssh，调用结束
 *    立刻删掉；不进命令行参数（`ps` 看得到）、不进日志、不进模型上下文。
 */

export type RemoteContext = {
  /** `$MICA_HOME/plugin-data/ssh`。known_hosts 与临时凭证都落在这里。 */
  dataDir: string;
  defaultTimeoutMs: number;
  /** 结果里最多保留多少行。 */
  tailLines: number;
  /** ControlPersist 秒数。 */
  persistSeconds: number;
  /** 连接超时秒数。 */
  connectTimeoutSeconds: number;
  sshBinary: string;
  sshKeygenBinary: string;
};

function positive(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * 从插件设置拼出运行上下文。
 *
 * 设置的原始值是字符串（配置页面的数字输入框），非法值在这里就落回默认值——不要让它变成
 * `NaN` 传到 `setTimeout`（那等于 0，命令会瞬间「超时」）。
 */
export function createRemoteContext(options: {
  dataDir: string;
  defaultTimeoutMs?: number;
  tailLines?: number;
  persistSeconds?: number;
  connectTimeoutSeconds?: number;
  sshBinary?: string;
  sshKeygenBinary?: string;
}): RemoteContext {
  return {
    dataDir: options.dataDir,
    defaultTimeoutMs: positive(options.defaultTimeoutMs, 120_000),
    tailLines: Math.min(5_000, positive(options.tailLines, 300)),
    persistSeconds: Math.min(86_400, positive(options.persistSeconds, 600)),
    connectTimeoutSeconds: positive(options.connectTimeoutSeconds, 10),
    sshBinary: options.sshBinary ?? 'ssh',
    sshKeygenBinary: options.sshKeygenBinary ?? 'ssh-keygen',
  };
}

export type RemoteRunOptions = {
  host: SshHost;
  script: string;
  cwd?: string;
  timeoutMs?: number;
  tailLines?: number;
  /** 把完整输出同时写到远端 `/tmp`（一次性执行用；只读查询不写）。 */
  remoteLog?: boolean;
  signal?: AbortSignal;
  onChunk?: (chunk: string) => void;
};

export type RemoteRunResult = {
  exitCode: number | null;
  output: string;
  totalLines: number;
  truncated: boolean;
  logPath: string | null;
  durationMs: number;
  timedOut: boolean;
  aborted: boolean;
  /** ssh 本身失败（认证、主机密钥、网络）时的可展示原因。 */
  error?: string;
};

const KNOWN_HOSTS_FILE = 'known_hosts';
const CONTROL_DIR_NAME = 'mica-ssh';

/**
 * ControlPath 必须短：unix domain socket 的路径上限是 104 字节，`$MICA_HOME` 或
 * `$TMPDIR` 一长就会静默退化成「每次都新建连接」——那正是要避免的那件事。
 * `/tmp/mica-ssh-<uid>/<hash>` 由 ssh 自己把 `%C` 展开成 40 位哈希。
 */
function controlDir(): string {
  const uid = typeof process.getuid === 'function' ? process.getuid() : 0;
  return join('/tmp', `${CONTROL_DIR_NAME}-${uid}`);
}

export function controlPathFor(): string {
  return join(controlDir(), '%C');
}

function ensureControlDir(): void {
  try {
    mkdirSync(controlDir(), { recursive: true, mode: 0o700 });
    chmodSync(controlDir(), 0o700);
  } catch {
    // 建不出来就让 ssh 自己报错，别在这里吞掉真正的原因。
  }
}

export function knownHostsPath(dataDir: string): string {
  return join(dataDir, KNOWN_HOSTS_FILE);
}

function ensureKnownHosts(dataDir: string): string {
  const file = knownHostsPath(dataDir);
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  try {
    writeFileSync(file, '', { flag: 'wx', mode: 0o600 });
  } catch {
    // 已存在就是目标状态
  }
  return file;
}

function expandHome(path: string): string {
  if (path === '~') return homedir();
  if (path.startsWith('~/')) return join(homedir(), path.slice(2));
  return path;
}

/** 单引号包裹一段任意文本（供拼进远端脚本的路径用）。 */
export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** 尾部保留：只看最后 N 行，但行数照实统计（好告诉模型「还有多少没给你看」）。 */
export class TailBuffer {
  private lines: string[] = [''];
  private chars = 0;
  private droppedLines = 0;

  constructor(
    private readonly maxLines: number,
    private readonly maxChars: number = 160_000,
  ) {}

  push(chunk: string): void {
    const parts = chunk.split('\n');
    this.lines[this.lines.length - 1] += parts[0];
    this.chars += parts[0].length;
    for (let index = 1; index < parts.length; index += 1) {
      this.lines.push(parts[index]);
      this.chars += parts[index].length + 1;
    }
    // 末位那个空串是「最后一行也有换行」的产物，不算一行，否则少留一行。
    while (
      (this.realLines() > this.maxLines || this.chars > this.maxChars) &&
      this.lines.length > 1
    ) {
      const removed = this.lines.shift();
      if (removed === undefined) break;
      this.chars -= removed.length + 1;
      this.droppedLines += 1;
    }
  }

  text(): string {
    // 末尾那个空元素是「最后一行也有换行」留下的，不是一行空输出。
    const lines = this.lines[this.lines.length - 1] === '' ? this.lines.slice(0, -1) : this.lines;
    return lines.join('\n');
  }

  get totalLines(): number {
    return this.droppedLines + this.realLines();
  }

  /** 真实行数：末尾空串只是换行留下的，不算一行。 */
  private realLines(): number {
    return this.lines.length - (this.lines[this.lines.length - 1] === '' ? 1 : 0);
  }

  get truncated(): boolean {
    return this.droppedLines > 0;
  }
}

/** ssh 自己往 stderr 打的、与命令无关的噪声。 */
const NOISE = [/^Warning: Permanently added .* to the list of known hosts\.\s*$/];

function isSshNoise(line: string): boolean {
  return NOISE.some((pattern) => pattern.test(line));
}

type AskpassHandle = { dir: string; path: string } | null;

/**
 * 口令认证的临时 askpass：目录 0700、脚本 0700、口令单独一个 0600 文件。
 *
 * 为什么不把口令拼进脚本正文：口令里可能有引号、`$`、反引号，拼错了表现为「认证失败」，
 * 而不是「脚本写错了」——那种 bug 查起来很贵。分成两个文件，脚本只 `cat`。
 */
export function createAskpass(password: string): AskpassHandle {
  const dir = mkdtempSync(join(tmpdir(), 'mica-ssh-ak-'));
  const passwordFile = join(dir, 'pw');
  const scriptPath = join(dir, 'askpass.sh');
  writeFileSync(passwordFile, password, { encoding: 'utf8', mode: 0o600 });
  writeFileSync(scriptPath, `#!/bin/sh\ncat "${passwordFile}"\n`, { encoding: 'utf8', mode: 0o700 });
  chmodSync(scriptPath, 0o700);
  return { dir, path: scriptPath };
}

export function disposeAskpass(handle: AskpassHandle): void {
  if (!handle) return;
  try {
    rmSync(handle.dir, { recursive: true, force: true });
  } catch {
    // 删不掉也不该让调用失败；目录在 tmp 下、权限 0700。
  }
}

export function buildSshArgs(
  ctx: RemoteContext,
  host: SshHost,
  options: { control: boolean; pty?: boolean },
): string[] {
  const knownHosts = knownHostsPath(ctx.dataDir);
  const args = [
    '-o',
    `ConnectTimeout=${ctx.connectTimeoutSeconds}`,
    '-o',
    'ServerAliveInterval=15',
    '-o',
    'ServerAliveCountMax=4',
    '-o',
    'LogLevel=ERROR',
    '-o',
    `UserKnownHostsFile=${knownHosts}`,
    '-o',
    'GlobalKnownHostsFile=/dev/null',
    '-o',
    'HashKnownHosts=no',
    '-o',
    'UpdateHostKeys=no',
    // 首次连接（还没有指纹）接受并记录，之后一律严格校验：指纹变了就拒绝连接，
    // 而不是在「安全」和「能用」之间悄悄选一个。
    '-o',
    `StrictHostKeyChecking=${host.fingerprint ? 'yes' : 'accept-new'}`,
    '-o',
    'NumberOfPasswordPrompts=1',
    '-p',
    String(host.port),
  ];
  if (options.control) {
    ensureControlDir();
    args.push(
      '-o',
      'ControlMaster=auto',
      '-o',
      `ControlPath=${controlPathFor()}`,
      '-o',
      `ControlPersist=${ctx.persistSeconds}`,
    );
  } else {
    args.push('-o', 'ControlMaster=no');
  }
  if (host.auth === 'password') {
    args.push(
      '-o',
      'PreferredAuthentications=password,keyboard-interactive',
      '-o',
      'PubkeyAuthentication=no',
      '-o',
      'KbdInteractiveAuthentication=yes',
    );
  } else if (host.auth === 'key') {
    args.push('-o', 'PreferredAuthentications=publickey', '-o', 'IdentitiesOnly=yes', '-i', expandHome(host.keyPath ?? ''));
  }
  // `-tt` 必须在目标之前。持久会话要它：没有 PTY 时远端程序的 stdout 是整块缓冲的，
  // `for ...; do echo; sleep; done` 要等循环结束才一次吐出来，`wait` 的分段读就永远读空。
  if (options.pty) args.push('-tt');
  args.push(`${host.user}@${host.host}`);
  return args;
}

function targetOf(host: SshHost): string {
  return `${host.user}@${host.host}:${host.port}`;
}

/**
 * 远端要执行的脚本文本（写进 ssh 的 stdin，由 `bash -l -s` 解释）。
 *
 * 走 stdin 而不是 `ssh host '...'`：脚本里的引号、换行、`$` 都不用再套一层转义，
 * 也就不会有「本地引号吃掉了远端引号」这类只在特定命令上才炸的问题。
 */
export function buildRemoteScript(options: {
  script: string;
  cwd?: string;
  remoteLog?: string | null;
}): string {
  const lines: string[] = [
    // pipefail：脚本失败但 tee 成功时，退出码仍应是脚本的。
    'set -o pipefail',
    // 登录 shell 会把 nvm/pyenv 这类工具链带进来（用户期望的 PATH），但也会带进配色、
    // 分页器与进度条——它们在非 tty 下只会把输出刷成一堆控制字符。
    'export TERM=dumb GIT_PAGER=cat PAGER=cat GIT_TERMINAL_PROMPT=0',
  ];
  if (options.cwd) {
    // `cd` 失败必须显式失败：否则命令会在登录目录里跑，把东西改到错的地方。
    lines.push(`cd -- ${shellQuote(options.cwd)} || { echo "mica: 目录不存在：${options.cwd.replaceAll('"', '')}" >&2; exit 97; }`);
  }
  const body = `{\n${options.script.replace(/\n$/, '')}\n}`;
  if (options.remoteLog) {
    lines.push(`__mica_log=${shellQuote(options.remoteLog)}`);
    lines.push(`${body} 2>&1 | tee "$__mica_log"`);
  } else {
    lines.push(`${body} 2>&1`);
  }
  return `${lines.join('\n')}\n`;
}

function remoteLogPath(): string {
  const stamp = Date.now().toString(36);
  const random = Math.random().toString(36).slice(2, 8);
  return `/tmp/mica-ssh-${stamp}-${random}.log`;
}

/** ssh 以自己的退出码 255 表示「连接/认证失败」，和远端命令的退出码不是一回事。 */
function explainSshFailure(host: SshHost, output: string): string | null {
  const haystack = output.toLowerCase();
  if (haystack.includes('remote host identification has changed')) {
    return `主机密钥已变（${targetOf(host)}）。可能是重装了系统或换了机器——确认无误后在 SSH 面板里重新信任这台主机。`;
  }
  if (haystack.includes('permission denied')) {
    return host.auth === 'password'
      ? `认证失败（${targetOf(host)}）：口令不对或服务器不接受口令登录。到 SSH 面板重新填一次口令。`
      : `认证失败（${targetOf(host)}）：检查私钥、用户名与服务器是否接受公钥登录。`;
  }
  if (haystack.includes('host key verification failed')) {
    return `${targetOf(host)} 的主机密钥不在信任列表里；在 SSH 面板点一次「测试连接」完成首次信任。`;
  }
  if (haystack.includes('could not resolve hostname')) return `域名解析失败：${host.host}`;
  if (haystack.includes('connection refused')) return `${targetOf(host)} 拒绝连接：端口不对或 sshd 没在跑。`;
  if (haystack.includes('timed out') || haystack.includes('operation timed out')) {
    return `连接 ${targetOf(host)} 超时：网络不通，或安全组没放行。`;
  }
  if (haystack.includes('no route to host')) return `到 ${targetOf(host)} 没有路由。`;
  return null;
}

export async function runRemote(ctx: RemoteContext, options: RemoteRunOptions): Promise<RemoteRunResult> {
  const { host } = options;
  const started = Date.now();
  const timeoutMs = options.timeoutMs ?? ctx.defaultTimeoutMs;
  const logPath = options.remoteLog ? remoteLogPath() : null;

  const finish = (partial: Partial<RemoteRunResult>): RemoteRunResult => ({
    exitCode: partial.exitCode ?? null,
    output: partial.output ?? '',
    totalLines: partial.totalLines ?? 0,
    truncated: partial.truncated ?? false,
    logPath,
    durationMs: Date.now() - started,
    timedOut: partial.timedOut ?? false,
    aborted: partial.aborted ?? false,
    ...(partial.error ? { error: partial.error } : {}),
  });

  if (host.auth === 'password' && !hasStoredPassword(host.id, ctx.dataDir)) {
    return finish({ error: `没有 ${host.id} 的口令：到 SSH 面板（或让用户）填一次密码。` });
  }

  ensureKnownHosts(ctx.dataDir);
  const password = host.auth === 'password' ? readPassword(host.id, ctx.dataDir) : null;
  const askpass = password ? createAskpass(password) : null;
  const tail = new TailBuffer(options.tailLines ?? ctx.tailLines);
  let pending = '';
  let exitCode: number | null = null;
  let timedOut = false;
  let aborted = false;
  let sshError: string | null = null;

  const args = buildSshArgs(ctx, host, { control: true });
  const child = spawn(ctx.sshBinary, [...args, 'bash -l -s'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      ...(askpass ? { SSH_ASKPASS: askpass.path, SSH_ASKPASS_REQUIRE: 'force' } : {}),
    },
  });

  const consume = (chunk: string): void => {
    if (!chunk) return;
    pending += chunk;
    // 噪声按整行过滤：ssh 的警告是完整一行，命令输出则原样保留。
    const lines = pending.split('\n');
    pending = lines.pop() ?? '';
    const kept: string[] = [];
    for (const line of lines) {
      if (!isSshNoise(line)) kept.push(line);
    }
    if (kept.length === 0) return;
    const text = `${kept.join('\n')}\n`;
    tail.push(text);
    options.onChunk?.(text);
    if (exitCode === null && /^Permission denied/m.test(text)) sshError = explainSshFailure(host, text);
  };

  child.stdout?.setEncoding('utf8');
  child.stderr?.setEncoding('utf8');
  child.stdout?.on('data', consume);
  child.stderr?.on('data', consume);

  child.stdin?.end(buildRemoteScript({ script: options.script, cwd: options.cwd, remoteLog: logPath }));

  const kill = (): void => {
    try {
      child.kill('SIGTERM');
    } catch {
      // 已经退出了
    }
    setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        // 同上
      }
    }, 1500).unref?.();
  };

  const timer = setTimeout(() => {
    timedOut = true;
    kill();
  }, Math.max(1000, timeoutMs));
  const onAbort = (): void => {
    aborted = true;
    kill();
  };
  options.signal?.addEventListener('abort', onAbort, { once: true });

  try {
    const closed = await new Promise<number | null>((resolve) => {
      let settled = false;
      const settle = (code: number | null): void => {
        if (settled) return;
        settled = true;
        resolve(code);
      };
      child.on('error', (error) => {
        sshError = `无法启动 ssh：${error.message}`;
        settle(null);
      });
      child.on('close', (code) => settle(code));
      // ControlMaster 的常驻进程是 ssh 自己 fork 出来的，它继承着这两个管道：被中断时
      // `close` 要等到远端那条命令自己结束才来（实测 sleep 5 会拖 4 秒）。进程一退就
      // 收尾，留一点时间把已经在管道里的最后几行读干净。
      child.on('exit', (code) => {
        setTimeout(() => settle(code), 250).unref?.();
      });
    });
    exitCode = closed;
    if (pending) {
      if (!isSshNoise(pending)) {
        tail.push(pending);
        options.onChunk?.(pending);
      }
      pending = '';
    }
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', onAbort);
    disposeAskpass(askpass);
  }

  const output = tail.text();
  // ssh 用 255 表示自己失败（认证/网络/主机密钥），此时远端命令根本没跑。
  if (timedOut) {
    sshError = `超过 ${Math.round(timeoutMs / 1000)}s 没结束，已中断。更久的任务用 ssh_session`;
  } else if (aborted) {
    sshError = '已中断';
  } else if (exitCode === 255) {
    sshError = explainSshFailure(host, output) ?? 'ssh 连接失败（退出码 255）';
  } else if (exitCode === null && !sshError) {
    sshError = 'ssh 进程异常结束';
  }

  return finish({
    exitCode,
    output,
    totalLines: tail.totalLines,
    truncated: tail.truncated,
    timedOut,
    aborted,
    ...(sshError ? { error: sshError } : {}),
  });
}

/** 多台机器并发跑同一段只读查询：一次模型往返拿到所有结果。 */
export async function runRemoteMany(
  ctx: RemoteContext,
  hosts: SshHost[],
  options: Omit<RemoteRunOptions, 'host'>,
): Promise<Map<string, RemoteRunResult>> {
  const results = await Promise.all(
    hosts.map(async (host) => {
      const result = await runRemote(ctx, { ...options, host, remoteLog: false });
      return [host.id, result] as const;
    }),
  );
  return new Map(results);
}

/**
 * 关掉某台机器的复用连接。
 *
 * 插件卸载时调用：`ControlPersist` 到点也会自己退出，但用户停用插件那一刻就该断开，
 * 而不是让一个后台 ssh 再挂十分钟。
 */
export function closeControlMaster(ctx: RemoteContext, host: SshHost): void {
  const args = [
    '-o',
    `ControlPath=${controlPathFor()}`,
    '-o',
    `UserKnownHostsFile=${knownHostsPath(ctx.dataDir)}`,
    '-O',
    'exit',
    `${host.user}@${host.host}`,
  ];
  try {
    spawn(ctx.sshBinary, args, { stdio: 'ignore' }).on('error', () => {});
  } catch {
    // 没有 master 时 `-O exit` 也会失败，这里不需要区分。
  }
}

export function closeAllControlMasters(ctx: RemoteContext, hosts: SshHost[]): void {
  for (const host of hosts) closeControlMaster(ctx, host);
}

/**
 * 读回当前连接用的主机密钥指纹，用来钉住这台机器。
 *
 * 用 `ssh-keygen -lf known_hosts` 一次列出全部条目再按目标筛：`-F` 对 `[host]:port`
 * 这种写法的匹配规则和这里要的不完全一致，而清单里最多几十台机器，全量列出很便宜。
 */
export function readHostFingerprint(ctx: RemoteContext, host: SshHost): string | null {
  const file = knownHostsPath(ctx.dataDir);
  const entry = host.port === 22 ? host.host : `[${host.host}]:${host.port}`;
  try {
    const output = execFileSync(ctx.sshKeygenBinary, ['-lf', file], {
      encoding: 'utf8',
      timeout: 10_000,
    });
    for (const line of output.split('\n')) {
      // 格式：`<bits> SHA256:xxx <host> (<TYPE>)`。按主机列比对，避免 `1.2.3.4` 命中
      // `11.2.3.4` 这种前缀相同的另一台机器。
      const columns = line.trim().split(/\s+/);
      if (columns.length < 3 || columns[columns.length - 2] !== entry) continue;
      const match = /(SHA256:[A-Za-z0-9+/=]+)/.exec(line);
      if (match) return match[1];
    }
    return null;
  } catch {
    return null;
  }
}

/** 强制重新信任：删掉 known_hosts 里这台机器的条目（换机器/重装系统后用）。 */
export function forgetHostKey(ctx: RemoteContext, host: SshHost): void {
  const file = knownHostsPath(ctx.dataDir);
  const entry = host.port === 22 ? host.host : `[${host.host}]:${host.port}`;
  try {
    const lines = readFileSync(file, 'utf8').split('\n');
    const kept = lines.filter((line) => line && !line.startsWith(`${entry} `) && !line.split(' ')[0].includes(entry));
    writeFileSync(file, kept.join('\n'), 'utf8');
  } catch {
    // 文件不存在就是没有条目要删
  }
  closeControlMaster(ctx, host);
}

/** 面板「测试连接」用：一条不依赖远端环境的命令。 */
export async function testConnection(
  ctx: RemoteContext,
  host: SshHost,
): Promise<{ ok: boolean; message: string; fingerprint: string | null }> {
  const result = await runRemote(ctx, {
    host,
    script: 'echo mica-ssh-ok; uname -sr; whoami; pwd',
    timeoutMs: 25_000,
    tailLines: 20,
  });
  const ok = result.exitCode === 0 && result.output.includes('mica-ssh-ok');
  if (!ok) {
    return { ok: false, message: result.error ?? `退出码 ${result.exitCode}`, fingerprint: null };
  }
  // 刚握手完成：accept-new 那条记录由 ssh 自己写入，给它一点落盘时间再读。
  let fingerprint = readHostFingerprint(ctx, host);
  if (!fingerprint) {
    await sleep(80);
    fingerprint = readHostFingerprint(ctx, host);
  }
  return {
    ok: true,
    message: result.output
      .split('\n')
      .filter((line) => line && line !== 'mica-ssh-ok')
      .join(' · ')
      .trim(),
    fingerprint,
  };
}
