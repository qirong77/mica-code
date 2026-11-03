import type { Disposable } from '@packages/mica-common/index.js';
import type { PluginToolRegistrationOptions } from '@packages/mica-plugin/index.js';
import type { PluginToolDescriptor } from '@packages/mica-tools/PluginTool.js';
import type { MicaTool, ToolExecuteCallbacks } from '@packages/mica-tools/index.js';
import { appendAudit } from './Audit.js';
import { findHost, mutateData, readData, upsertHost, type SshData, type SshHost } from './Hosts.js';
import {
  runRemote,
  runRemoteMany,
  readHostFingerprint,
  type RemoteContext,
  type RemoteRunResult,
} from './Remote.js';
import { SessionManager, type SessionWaitResult } from './Session.js';
import { deletePassword } from './Secrets.js';

/**
 * 模型能操作服务器的唯一入口：四个工具。
 *
 * 工具描述是**唯一**能改变模型行为的文档（它进 prompt 的前缀，改一次缓存就失效一次），
 * 所以效率规则写在描述里，而不是写在 README 里：
 *
 * - 「一次脚本做完一件事」——每次调用都是一轮模型请求，拆成五条比合成一条慢五倍；
 * - 「只读查询用 `ssh_read`」——它会并发跑，一次往返查完多台；
 * - 「长任务用 `ssh_session`」——不撞超时，也能分段取结果。
 */

export type ToolDeps = {
  ctx: RemoteContext;
  dataFile: string;
  sessions: SessionManager;
  register(tool: MicaTool | PluginToolDescriptor, options?: PluginToolRegistrationOptions): Disposable;
};

const MAX_TIMEOUT_MS = 600_000;

function seconds(ms: number): string {
  return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`;
}

function header(host: SshHost, result: RemoteRunResult): string {
  const status = result.error ? `失败：${result.error}` : `exit=${result.exitCode}`;
  const flags: string[] = [seconds(result.durationMs)];
  if (result.timedOut) flags.push('已超时中断');
  if (result.aborted) flags.push('已中断');
  if (result.truncated) flags.push(`共 ${result.totalLines} 行，只保留最后 ${result.output.split('\n').length} 行`);
  if (result.logPath) flags.push(`完整输出：${host.id}:${result.logPath}`);
  return `[${host.id}] ${status} · ${flags.join(' · ')}`;
}

/** 工具结果给模型看的正文：头部一行状态 + 输出正文。 */
export function formatResult(host: SshHost, result: RemoteRunResult): string {
  const head = header(host, result);
  const body = result.output.replace(/\s+$/, '');
  return body ? `${head}\n${body}` : head;
}

function trimSessionOutput(output: string, tailLines: number): { text: string; total: number; truncated: boolean } {
  const lines = output.replace(/\s+$/, '').split('\n');
  if (lines.length <= tailLines) return { text: lines.join('\n'), total: lines.length, truncated: false };
  return { text: lines.slice(-tailLines).join('\n'), total: lines.length, truncated: true };
}

export function formatSessionResult(
  sessionId: string,
  result: SessionWaitResult,
  started: number,
  tailLines: number,
): string {
  if (result.dead) return `[${sessionId}] 会话已结束（连接断开或远端 exit），需要重新 \`open\``;
  const trimmed = trimSessionOutput(result.output, tailLines);
  const flags = [seconds(Date.now() - started)];
  if (result.timedOut) flags.push('等待超时（命令可能还在跑，用 `wait` 继续等或 `read` 取增量）');
  if (trimmed.truncated) flags.push(`共 ${trimmed.total} 行，只保留最后 ${tailLines} 行`);
  const status = result.timedOut ? '还在跑' : `exit=${result.exitCode}`;
  return trimmed.text
    ? `[${sessionId}] ${status} · ${flags.join(' · ')}\n${trimmed.text}`
    : `[${sessionId}] ${status} · ${flags.join(' · ')}`;
}

/**
 * 只读工具里挡掉的「显然会改东西」的写法。
 *
 * 这不是安全边界（真正的边界是主机清单里的只读标记与服务器侧账号权限），而是**别让
 * `ssh_read` 变成一条绕过串行屏障的捷径**：`readOnly` 工具会被并发、也可能被重试，
 * 一条 `rm -rf` 放在里面既不该并发也不该重放。
 */
const MUTATING_PATTERNS: Array<{ pattern: RegExp; why: string }> = [
  { pattern: /\brm\s+-[a-z]*[rf]/i, why: 'rm -rf' },
  { pattern: /\bmkfs\b/i, why: 'mkfs' },
  { pattern: /\bdd\s+[^\n]*\bof=/i, why: 'dd of=' },
  { pattern: /\b(shutdown|reboot|halt|poweroff)\b/i, why: '关机/重启' },
  { pattern: /\bsystemctl\s+(start|stop|restart|reload|disable|enable)\b/i, why: 'systemctl 变更' },
  { pattern: /\b(apt|apt-get|yum|dnf|apk|brew)\s+(install|remove|purge|upgrade)\b/i, why: '包管理安装/卸载' },
  { pattern: /\b(docker|podman)\s+(rm|rmi|stop|kill|down|prune)\b/i, why: '容器删除/停止' },
  { pattern: /\bgit\s+(push|reset|rebase|clean)\b/i, why: 'git 写操作' },
  { pattern: /(^|\s)>\s*\/?(etc|usr|var|boot|opt)\//i, why: '重定向覆盖系统文件' },
  { pattern: /\bkill(all)?\s+-9\b/i, why: 'kill -9' },
];

export function findMutatingHint(script: string): string | null {
  for (const { pattern, why } of MUTATING_PATTERNS) {
    if (pattern.test(script)) return why;
  }
  return null;
}

function asHost(deps: ToolDeps, name: string): { host: SshHost | null; error: string } {
  const data = readData(deps.dataFile);
  const host = findHost(data, name);
  if (host) return { host, error: '' };
  const known = data.hosts.map((entry) => entry.id).join('、') || '（还没有配置任何服务器）';
  return { host: null, error: `找不到服务器 \`${name}\`。已配置：${known}。到桌面端 SSH 面板添加。` };
}

function timeoutOf(value: unknown, fallback: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(MAX_TIMEOUT_MS, Math.max(1000, Math.round(parsed)));
}

/** 行数是另一把尺子：别跟超时的 1s 下限共用，那会把「只要 200 行」抬成 1000 行。 */
function linesOf(value: unknown, fallback: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(5000, Math.max(20, Math.round(parsed)));
}

export function createTools(deps: ToolDeps): Disposable[] {
  const { ctx, dataFile, sessions } = deps;

  const runTool: PluginToolDescriptor = {
    name: 'ssh_run',
    description: [
      '在一台远程服务器上执行一段 bash 脚本，等它结束，返回退出码与输出（只保留尾部，全文在远端 /tmp）。',
      '',
      '**一次脚本做完一件事**：每次调用都是一轮模型请求，把「查状态 → 看日志 → 改配置 → 重启 → 验证」写成同一个多行脚本，比一条命令一次调用快数倍。',
      '脚本在一个登录 shell 里跑（`bash -l`），所以 nvm / pyenv 这类在 profile 里配的 PATH 是生效的。',
      '写操作（安装、重启、改文件、删东西）一律用它；只想读用 `ssh_read`（可并发、多台一次往返）。',
      '比默认超时更长的任务（构建、安装）用 `ssh_session`，否则会到点被打断。',
    ].join('\n'),
    input_schema: {
      type: 'object',
      properties: {
        host: { type: 'string', description: '服务器别名（见 system prompt 里的清单）' },
        script: { type: 'string', description: '多行 bash 脚本；一次做完一件事' },
        cwd: { type: 'string', description: '先进入这个绝对目录，失败即中止（默认登录目录）' },
        timeout_ms: {
          type: 'number',
          description: `超时毫秒，默认 ${ctx.defaultTimeoutMs}，上限 ${MAX_TIMEOUT_MS}；到点会中断本次调用`,
        },
        tail_lines: { type: 'number', description: `结果里最多保留多少行输出，默认 ${ctx.tailLines}` },
      },
      required: ['host', 'script'],
    },
    displayText(input) {
      const script = String(input.script ?? '')
        .replace(/\s+/g, ' ')
        .trim();
      return `${String(input.host ?? '')} · ${script.slice(0, 80)}${script.length > 80 ? '…' : ''}`;
    },
    async execute(input, callbacks?: ToolExecuteCallbacks) {
      const found = asHost(deps, String(input.host ?? ''));
      if (!found.host) return found.error;
      const host = found.host;
      if (host.readOnly) {
        return `[${host.id}] 这台机器在清单里标为只读，\`ssh_run\` 被拒绝。查询请用 \`ssh_read\`；确实要改就在 SSH 面板里取消只读。`;
      }
      const script = String(input.script ?? '');
      if (!script.trim()) return '脚本是空的';
      const started = Date.now();
      const result = await runRemote(ctx, {
        host,
        script,
        cwd: typeof input.cwd === 'string' && input.cwd.trim() ? input.cwd.trim() : undefined,
        timeoutMs: timeoutOf(input.timeout_ms, ctx.defaultTimeoutMs),
        tailLines: linesOf(input.tail_lines, ctx.tailLines),
        remoteLog: true,
        signal: callbacks?.signal,
        onChunk: callbacks?.onChunk,
      });
      appendAudit(ctx.dataDir, {
        at: new Date().toISOString(),
        hostId: host.id,
        target: `${host.user}@${host.host}:${host.port}`,
        source: 'run',
        script,
        exitCode: result.exitCode,
        durationMs: Date.now() - started,
        ok: result.exitCode === 0,
        ...(result.truncated && result.logPath ? { logPath: result.logPath } : {}),
        ...(result.error ? { note: result.error } : {}),
      });
      return formatResult(host, result);
    },
  };

  const readTool: PluginToolDescriptor = {
    name: 'ssh_read',
    description: [
      '只读查询：执行一段**只读**命令（ps / df / tail / cat / grep / systemctl status / docker ps）并返回尾部输出。',
      '',
      '与 `ssh_run` 的区别：它会被并发执行，`hosts` 给多台时**一次模型往返查完全部**（巡检、对比配置的首选）。',
      '它拒绝明显的写操作（rm / 安装 / 重启 / git push 等），那些必须走 `ssh_run`。',
    ].join('\n'),
    input_schema: {
      type: 'object',
      properties: {
        script: { type: 'string', description: '只读 bash 脚本，会在每台机器上各跑一次' },
        host: { type: 'string', description: '单个别名；多台用 `hosts`' },
        hosts: { type: 'array', items: { type: 'string' }, description: '多个别名，并发执行' },
        timeout_ms: { type: 'number', description: `超时毫秒，默认 ${ctx.defaultTimeoutMs}` },
        tail_lines: { type: 'number', description: `每台最多保留多少行，默认 ${ctx.tailLines}` },
      },
      required: ['script'],
    },
    readOnly: true,
    displayText(input) {
      const targets = Array.isArray(input.hosts) ? input.hosts.join(', ') : String(input.host ?? '');
      const script = String(input.script ?? '')
        .replace(/\s+/g, ' ')
        .trim();
      return `${targets} · ${script.slice(0, 60)}${script.length > 60 ? '…' : ''}`;
    },
    async execute(input, callbacks?: ToolExecuteCallbacks) {
      const script = String(input.script ?? '');
      if (!script.trim()) return '脚本是空的';
      const hint = findMutatingHint(script);
      if (hint) {
        return `\`ssh_read\` 是只读工具（可并发、可重试），脚本里出现了「${hint}」。改用 \`ssh_run\`。`;
      }
      const names = Array.isArray(input.hosts)
        ? input.hosts.map((entry) => String(entry))
        : input.host
          ? [String(input.host)]
          : [];
      if (names.length === 0) return '至少给一个 host 或 hosts';
      const data: SshData = readData(dataFile);
      const resolved: SshHost[] = [];
      const missing: string[] = [];
      for (const name of names) {
        const host = findHost(data, name);
        if (host) resolved.push(host);
        else missing.push(name);
      }
      if (resolved.length === 0) return asHost(deps, names[0]).error;
      const timeoutMs = timeoutOf(input.timeout_ms, ctx.defaultTimeoutMs);
      const tailLines = linesOf(input.tail_lines, ctx.tailLines);
      const started = Date.now();
      const results = await runRemoteMany(ctx, resolved, {
        script,
        timeoutMs,
        tailLines,
        signal: callbacks?.signal,
        onChunk: callbacks?.onChunk,
      });
      const parts: string[] = [];
      for (const host of resolved) {
        const result = results.get(host.id);
        if (!result) continue;
        appendAudit(ctx.dataDir, {
          at: new Date().toISOString(),
          hostId: host.id,
          target: `${host.user}@${host.host}:${host.port}`,
          source: 'read',
          script,
          exitCode: result.exitCode,
          durationMs: Date.now() - started,
          ok: result.exitCode === 0,
          ...(result.error ? { note: result.error } : {}),
        });
        parts.push(formatResult(host, result));
      }
      if (missing.length > 0) parts.push(`未配置的别名：${missing.join('、')}`);
      return parts.join('\n\n');
    },
  };

  const sessionTool: PluginToolDescriptor = {
    name: 'ssh_session',
    description: [
      '在远程服务器上开一条**持久 bash 会话**：`cd`、环境变量、venv 都跨调用保留。',
      '',
      `用途：比工具超时更长或需要连续状态的活（npm install、make、docker build、进目录后连做几步）。`,
      '用法：`open` 一次 → 之后 `run`（写并等，最常用）；长任务可以 `write` 后先做别的、再 `wait`；`read` 取增量；`close` 收尾（不收也会在一小时后回收）。',
      '没有 pty：vim / top 这类全屏交互用不了，也不该由你来做。每台机器一条会话（`session_id` 默认就是主机别名）。',
    ].join('\n'),
    input_schema: {
      type: 'object',
      properties: {
        op: {
          type: 'string',
          enum: ['open', 'run', 'write', 'wait', 'read', 'close', 'list'],
          description: 'open 建会话；run 写并等；write 只写；wait 等上一次 write；read 取缓冲；close 关闭；list 列出',
        },
        host: { type: 'string', description: 'op=open 时的服务器别名（其它 op 可省略）' },
        session_id: { type: 'string', description: '会话 id，等于主机别名；省略时用 host' },
        command: { type: 'string', description: 'op=run / write 时要执行的 bash' },
        cwd: { type: 'string', description: 'op=open 时的初始目录' },
        timeout_ms: { type: 'number', description: `op=run / wait 的等待上限，默认 ${ctx.defaultTimeoutMs}` },
        tail_lines: { type: 'number', description: `结果里最多保留多少行，默认 ${ctx.tailLines}` },
      },
      required: ['op'],
    },
    displayText(input) {
      const id = String(input.session_id ?? input.host ?? '');
      if (input.op === 'run') {
        const command = String(input.command ?? '')
          .replace(/\s+/g, ' ')
          .trim();
        return `${id} · ${command.slice(0, 60)}${command.length > 60 ? '…' : ''}`;
      }
      return `${id} · ${String(input.op ?? '')}`;
    },
    async execute(input) {
      const op = String(input.op ?? '');
      const tailLines = linesOf(input.tail_lines, ctx.tailLines);
      const started = Date.now();
      if (op === 'list') {
        const items = sessions.list();
        if (items.length === 0) return '当前没有打开的持久会话';
        return items
          .map((item) => `- ${item.id} · ${item.target} · cwd=${item.cwd} · ${item.running ? '有命令在跑' : '空闲'}`)
          .join('\n');
      }
      if (op === 'open') {
        const found = asHost(deps, String(input.host ?? ''));
        if (!found.host) return found.error;
        const { info } = await sessions.open(found.host, {
          cwd: typeof input.cwd === 'string' ? input.cwd : undefined,
        });
        appendAudit(ctx.dataDir, {
          at: new Date().toISOString(),
          hostId: found.host.id,
          target: `${found.host.user}@${found.host.host}:${found.host.port}`,
          source: 'session',
          script: `open ${info.cwd}`,
          exitCode: 0,
          durationMs: Date.now() - started,
          ok: true,
        });
        return `[${info.id}] 持久会话已就绪 · cwd=${info.cwd}\n之后用 \`run\` 执行命令（cd / 环境变量 / 虚拟环境都会保留）。`;
      }
      const id = String(input.session_id ?? input.host ?? '').trim();
      if (!id) return '需要 session_id（等于主机别名，或 open 时返回的 id）';
      if (!sessions.get(id)) return `[${id}] 没有打开的会话：先 \`open\`（或它已被关闭/超时回收）`;
      if (op === 'run' || op === 'write') {
        const command = String(input.command ?? '');
        if (!command.trim()) return 'command 是空的';
        if (op === 'write') {
          const { token } = sessions.write(id, command);
          return `[${id}] 已写入（token=${token}）。用 \`wait\` 取结果，或先做别的事。`;
        }
        const result = await sessions.run(id, command, timeoutOf(input.timeout_ms, ctx.defaultTimeoutMs));
        appendAudit(ctx.dataDir, {
          at: new Date().toISOString(),
          hostId: id,
          target: id,
          source: 'session',
          script: command,
          exitCode: result.exitCode,
          durationMs: Date.now() - started,
          ok: result.exitCode === 0,
        });
        return formatSessionResult(id, result, started, tailLines);
      }
      if (op === 'wait') {
        const result = await sessions.wait(id, timeoutOf(input.timeout_ms, ctx.defaultTimeoutMs));
        return formatSessionResult(id, result, started, tailLines);
      }
      if (op === 'read') {
        const text = sessions.read(id);
        return text ? `[${id}] 增量输出：\n${trimSessionOutput(text, tailLines).text}` : `[${id}] 没有新输出`;
      }
      if (op === 'close') {
        sessions.close(id);
        return `[${id}] 会话已关闭`;
      }
      return `不认识的 op：${op}`;
    },
  };

  const hostsTool: PluginToolDescriptor = {
    name: 'ssh_hosts',
    description: [
      '管理远程服务器清单（别名 / 地址 / 端口 / 用户名 / 认证方式 / 只读）。',
      '',
      '**口令不经过这里**：`auth=password` 的机器创建后要用户在桌面端 SSH 面板填一次密码（口令不该出现在对话里，也不该进会话文件）。',
      '列出来的清单同时出现在 system prompt 里，所以不用每轮先查一遍。',
    ].join('\n'),
    input_schema: {
      type: 'object',
      properties: {
        op: { type: 'string', enum: ['list', 'add', 'update', 'remove'], description: '默认 list' },
        id: { type: 'string', description: '别名（工具里的 host 参数就是它）' },
        host: { type: 'string', description: '域名或 IP，不带用户名/端口' },
        user: { type: 'string', description: '登录用户名' },
        port: { type: 'number', description: '端口，默认 22' },
        auth: { type: 'string', enum: ['password', 'key', 'agent'], description: '认证方式' },
        keyPath: { type: 'string', description: 'auth=key 时的私钥路径，支持 ~/.ssh/xxx' },
        label: { type: 'string', description: '一句话用途（「测试机」「生产 API」）' },
        readOnly: { type: 'boolean', description: '只读：ssh_run 会被拒绝，只能 ssh_read' },
      },
    },
    displayText(input) {
      return `${String(input.op ?? 'list')}${input.id ? ` ${String(input.id)}` : ''}`;
    },
    async execute(input) {
      const op = String(input.op ?? 'list');
      if (op === 'list') {
        const data = readData(dataFile);
        if (data.hosts.length === 0) return '还没有配置服务器';
        return data.hosts
          .map((host) => {
            const bits = [
              `${host.id} — ${host.user}@${host.host}:${host.port}`,
              host.auth === 'key' ? `密钥 ${host.keyPath}` : host.auth === 'password' ? '密码认证' : '使用 ssh agent/config',
              host.label ?? '',
              host.readOnly ? '只读' : '',
              host.fingerprint ? `指纹 ${host.fingerprint}` : '未信任(首次连接会记录指纹)',
            ].filter(Boolean);
            return `- ${bits.join(' · ')}`;
          })
          .join('\n');
      }
      if (op === 'remove') {
        const id = String(input.id ?? '').trim();
        if (!id) return 'remove 需要 id';
        const removed = await mutateData(dataFile, (data) => {
          const next = data.hosts.filter((entry) => entry.id !== id);
          if (next.length === data.hosts.length) throw new Error(`没有叫 ${id} 的服务器`);
          return { data: { ...data, hosts: next }, result: id };
        });
        sessions.close(removed);
        deletePassword(removed, ctx.dataDir);
        return `已删除 ${removed}（口令也一并清掉了）`;
      }
      if (op !== 'add' && op !== 'update') return `不认识的 op：${op}`;
      const id = String(input.id ?? '').trim();
      const outcome = await mutateData(dataFile, (data) => {
        const result = upsertHost(data, {
          id,
          host: String(input.host ?? ''),
          user: String(input.user ?? ''),
          port: input.port === undefined ? 22 : Number(input.port),
          auth: String(input.auth ?? 'agent'),
          keyPath: typeof input.keyPath === 'string' ? input.keyPath : undefined,
          label: typeof input.label === 'string' ? input.label : undefined,
          readOnly: input.readOnly === true,
        });
        return { data: result.data, result };
      });
      sessions.close(outcome.host.id);
      const fingerprint = outcome.host.fingerprint ?? readHostFingerprint(ctx, outcome.host);
      const notes = [
        outcome.created ? `已添加 ${outcome.host.id}` : `已更新 ${outcome.host.id}`,
        `${outcome.host.user}@${outcome.host.host}:${outcome.host.port}`,
        outcome.host.auth === 'password'
          ? '认证方式是密码：请用户在桌面端 SSH 面板（输入框上方的「SSH 服务器」）填一次口令，之后就能用。'
          : outcome.host.auth === 'key'
            ? `私钥：${outcome.host.keyPath}`
            : '认证走本机的 ssh agent / ~/.ssh/config',
        fingerprint ? `已知指纹 ${fingerprint}` : '首次连接会自动记录主机指纹',
      ];
      return notes.join('\n');
    },
  };

  return [runTool, readTool, sessionTool, hostsTool].map((descriptor) =>
    deps.register(descriptor, { icon: '🖧' }),
  );
}
