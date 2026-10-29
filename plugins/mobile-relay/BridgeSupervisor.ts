import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PluginContext } from '@packages/mica-plugin/PluginContext.js';
import { BRIDGE_SOURCE } from './bridgeSource.js';

/**
 * 常驻桥进程的监管。
 *
 * 桥不能跑在插件进程里：官方插件载在**每会话**的 app-server 中，用户关掉那个页签
 * 进程就退了，手机端会莫名其妙掉线。所以桥是一个脱离父进程的常驻子进程，由这里的
 * 常驻任务负责「活着就重启、停了就保证停止」。
 *
 * 真正的约束在最后一条：插件停用 → ctx 释放 → 常驻任务被回收 → 子进程被杀掉。
 * 以前它是用 launchd 单独装的，插件关了它照跑，用户根本不知道还有东西在外联。
 *
 * 脚本来自内嵌源码（`bridgeSource.ts`，由 `scripts/generate-mobile-relay-sources.mjs`
 * 生成）：随包插件跑在单二进制里，插件目录不是可执行目录，必须先把 `.mjs` 落盘，
 * 再交给 `node` 跑——和 `packages/mica-pty` 起 helper 是同一套做法。
 */

const LOCK_NAME = 'bridge.lock';
const SCRIPT_NAME = 'bridge.mjs';
const DATA_NAME = 'data.json';
/** 随包 skill 的源码位置；正文内嵌在二进制里，这一条只是给人点开看的地方。 */
const SKILL_URL = 'https://github.com/qironglin77/mica-code/tree/main/plugins/mobile-relay/skill';

type LockRecord = { pid: number; startedAt: number };

function isAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** 落盘桥脚本；内容没变就不重写，免得每次启动都产生一次 mtime 变化。 */
export function materializeBridge(dir: string): string {
  mkdirSync(dir, { recursive: true });
  const target = join(dir, SCRIPT_NAME);
  if (existsSync(target)) {
    try {
      if (readFileSync(target, 'utf8') === BRIDGE_SOURCE) return target;
    } catch {
      // 读不了就当需要重写：写失败会抛出来，比留一个坏文件好
    }
  }
  writeFileSync(target, BRIDGE_SOURCE, 'utf8');
  return target;
}

export function createBridgeSupervisor(ctx: PluginContext, options: { dataDir: string | null }) {
  const dir = options.dataDir;
  const lockPath = dir ? join(dir, LOCK_NAME) : null;

  const readLock = (): LockRecord | null => {
    if (!lockPath || !existsSync(lockPath)) return null;
    try {
      const parsed = JSON.parse(readFileSync(lockPath, 'utf8')) as Partial<LockRecord>;
      if (typeof parsed.pid !== 'number') return null;
      return { pid: parsed.pid, startedAt: Number(parsed.startedAt) || 0 };
    } catch {
      return null;
    }
  };

  const clearLock = () => {
    if (!lockPath) return;
    try {
      rmSync(lockPath, { force: true });
    } catch {
      // 清不掉只会让下一轮重试，不该打断监管循环
    }
  };

  /**
   * 启动这一份桥时用的「地址 + 口令」。
   *
   * 桥只在启动时读一次配置，所以换了中转机必须重启它；空字符串表示「这份桥不是本实例
   * 启动的」（比如上次会话留下的），此时只记录当前配置、不贸然杀掉。
   */
  let runningFor = '';
  const configFingerprint = (): string => {
    const values = ctx.settings.get();
    const url = String(values.relayUrl ?? '').trim().replace(/\/+$/, '');
    return `${url}|${String(values.token ?? '')}`;
  };

  const runningPid = (): number | null => {
    const lock = readLock();
    if (!lock) return null;
    if (isAlive(lock.pid)) return lock.pid;
    // 进程已经没了：锁是垃圾，清掉，下一轮重新拉起
    clearLock();
    return null;
  };

  const start = (): number | null => {
    if (!lockPath || !dir) return null;
    const script = materializeBridge(dir);
    const nodeBin = process.env.MICA_BRIDGE_NODE || 'node';
    // 宿主被 SIGKILL 时 onDispose 跑不到：桥自己盯着父进程，父进程没了就退，避免留下孤儿进程
    const child = spawn(nodeBin, [script], {
      detached: true,
      stdio: 'ignore',
      env: { ...process.env, MICA_RELAY_PARENT_PID: String(process.pid) }
    });
    child.on('error', (error) => {
      ctx.logger.error('bridge:spawn-failed', { error: error instanceof Error ? error.message : String(error) });
    });
    child.unref();
    if (!child.pid) return null;
    writeFileSync(lockPath, JSON.stringify({ pid: child.pid, startedAt: Date.now() }), 'utf8');
    runningFor = configFingerprint();
    return child.pid;
  };

  const stop = () => {
    const pid = runningPid();
    if (pid === null) return false;
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      // 已经退出
    }
    clearLock();
    return true;
  };

  /** 保证「该跑的跑着、不该跑的不跑」。 */
  const ensure = (): { pid: number | null; changed: boolean } => {
    const values = ctx.settings.get();
    const relayUrl = String(values.relayUrl ?? '').trim();
    const token = String(values.token ?? '').trim();
    if (!relayUrl || !token) {
      // 还没接入：不留一个只会失败的进程在外联，也不把「缺哪个字段」当报错甩给用户
      stop();
      ctx.health.report({
        level: 'warn',
        message: '这台机器还没接入中转机',
        hint: '在插件设置里填「中转地址」，再点「注册到中转机」——口令由插件自己拿到。',
      });
      return { pid: null, changed: false };
    }
    const issues = ctx.settings.validate();
    if (issues.length > 0) {
      // 配置不全时不要留着一个连不上中转机的进程在外联
      stop();
      ctx.health.report({
        level: 'warn',
        message: `配置不完整：${issues.map((issue) => `${issue.key} ${issue.message}`).join('；')}`,
      });
      return { pid: null, changed: false };
    }
    if (String(values.enabled ?? 'true') === 'false') {
      const stopped = stop();
      if (stopped) ctx.logger.info('bridge:stopped', { reason: 'disabled' });
      return { pid: null, changed: stopped };
    }
    const current = runningPid();
    if (current !== null) {
      const want = configFingerprint();
      if (!runningFor) {
        // 上一轮会话留下的桥：认领它，不改动
        runningFor = want;
        return { pid: current, changed: false };
      }
      if (runningFor !== want) {
        // 换了中转机或口令：先停，下一跳按新配置拉起
        stop();
        ctx.logger.info('bridge:restart-reason', { reason: 'settings-changed' });
        return { pid: null, changed: true };
      }
      return { pid: current, changed: false };
    }
    const started = start();
    if (started !== null) ctx.logger.info('bridge:started', { pid: started });
    return { pid: started, changed: true };
  };

  return { ensure, stop, runningPid, scriptPath: () => (dir ? join(dir, SCRIPT_NAME) : null) };
}

/** 一条状态行：插件自己判断语气，页面只负责上色。 */
export type StatusLine = { text: string; tone: 'ok' | 'warn' | 'error' };

/** 卡片读的那份状态。字段少而直接，改结构要同步 `desktop.jsx`。 */
export type BridgeStatus = {
  relayUrl: string;
  phoneUrl: string;
  bridgePid: number | null;
  enabled: boolean;
  relayOnline: boolean;
  agentOnline: boolean;
  phoneOnline: boolean;
  updatedAt: number;
  /**
   * 配置页「运行状态」要的那几行（清单 `status` 声明）。
   *
   * 插件自己判断通/不通，页面只按 `tone` 上色——配置页不该认识这台机器的运行语义。
   */
  bridge: StatusLine;
  relay: StatusLine;
  phone: StatusLine;
  /** 内置部署 skill 的源码位置（正文随包内嵌，这里只给可点开的地方）。 */
  skill: string;
};

/** 纯函数：把设置与中转机健康合成卡片要显示的那一份（便于单测，不碰网络）。 */
export function buildStatus(
  values: Record<string, string | undefined>,
  relay: Record<string, unknown> | null,
  pid: number | null,
  now: number,
): BridgeStatus {
  const relayUrl = String(values.relayUrl ?? '').trim().replace(/\/+$/, '');
  const token = String(values.token ?? '').trim();
  const enabled = String(values.enabled ?? 'true') !== 'false';
  const relayOnline = relay !== null;
  const phoneOnline = relay?.phoneOnline === true;
  return {
    relayUrl,
    // 链接里带口令：手机扫一眼就能开，不用再去翻设置。
    // 没登记过口令（短于 16 位的中转机一律 401）时不给链接：那条 URL 打不开，
    // 显示出来只会让人以为「已经配好了、只是连不上」。
    phoneUrl: relayUrl && token.length >= 16 ? `${relayUrl}/?t=${encodeURIComponent(token)}` : '',
    bridgePid: pid,
    enabled,
    relayOnline,
    agentOnline: relay?.agentOnline === true,
    phoneOnline,
    bridge: !enabled
      ? { text: '已停用', tone: 'warn' }
      : pid
        ? { text: `运行中 · pid ${pid}`, tone: 'ok' }
        : { text: '未运行', tone: 'error' },
    relay: !relayUrl
      ? { text: '未配置', tone: 'warn' }
      : relayOnline
        ? { text: '可达', tone: 'ok' }
        : { text: '不可达', tone: 'error' },
    phone: !relayUrl
      ? { text: '未配置', tone: 'warn' }
      : phoneOnline
        ? { text: '正在查看', tone: 'ok' }
        : { text: '未连接', tone: 'warn' },
    // 部署不在插件里做：给出内置 skill 的源码位置，用户对着 agent 说一句话就能装。
    skill: SKILL_URL,
    updatedAt: now,
  };
}

/**
 * 把当前状态写进插件自己的 `plugin-data/mobile-relay/data.json`。
 *
 * 卡片只能 `readData()` 读这一份，读不到 `plugin-settings`，所以「手机链接是什么、
 * 现在通没通」得由这里替它算好。写的是自己的数据文件，不是别人的。
 */
async function probeRelay(ctx: PluginContext): Promise<Record<string, unknown> | null> {
  const values = ctx.settings.get();
  const relayUrl = String(values.relayUrl ?? '').trim().replace(/\/+$/, '');
  const token = String(values.token ?? '');
  if (!relayUrl) return null;
  try {
    // 带上口令才拿得到「这一台」的在线状态；不带只能知道中转机活着。
    const response = await fetch(`${relayUrl}/api/health`, {
      headers: token ? { 'x-relay-token': token } : {},
      signal: AbortSignal.timeout(5_000),
    });
    if (response.ok) return (await response.json()) as Record<string, unknown>;
  } catch {
    // 中转机不可达是正常状态（关机、重建中），卡片显示「不可达」即可
  }
  return null;
}

/**
 * 内容没变就不落盘，免得每跳都改一次文件。
 *
 * 上一轮的内容由调用方保管（不放在模块级），否则同一进程里的多个会话实例会互相压制。
 */
function publishStatus(
  ctx: PluginContext,
  dir: string | null,
  pid: number | null,
  relay: Record<string, unknown> | null,
  previous: string | null
): string | null {
  if (!dir) return previous;
  const status = buildStatus(ctx.settings.get(), relay, pid, Date.now());
  const body = `${JSON.stringify(status, null, 2)}\n`;
  if (body === previous) return previous;
  try {
    writeFileSync(join(dir, DATA_NAME), body, 'utf8');
    return body;
  } catch (error) {
    ctx.logger.warn('bridge:status-write-failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    return previous;
  }
}

/** 中转机探活间隔：比监管跳数稀，避免检查本身变成额外的周期性请求。 */
const RELAY_PROBE_MS = 15_000
/** 监管跳数。ensure() 只读配置和 lock，开销极小；跳得密是为了桥一挂就拉起来。 */
const SUPERVISE_MS = 3_000

/**
 * 把监管注册成一个常驻任务。
 *
 * 3 秒一跳：桥的存活取决于宿主进程，宿主随最后一个会话页签退出，
 * 所以恢复越快越好；中转机探活另按 15 秒节流。
 */
export function registerBridgeSupervisor(ctx: PluginContext, dataDir: string | null) {
  const background = ctx.background;
  if (!background) {
    ctx.health.report({
      level: 'warn',
      message: '宿主没有提供 background 能力，桥不会随插件启停',
      hint: '检查 plugin.json 的 requires 是否包含 background',
    });
    return null;
  }

  const supervisor = createBridgeSupervisor(ctx, { dataDir });
  // 探活缓存：上一轮的中转机状态与它的探活时刻
  let relay: Record<string, unknown> | null = null;
  let relayProbedAt = 0;
  let relayProbedFor = '';
  let published: string | null = null;
  const registration = background.register({
    id: 'bridge',
    every: SUPERVISE_MS,
    immediate: true,
    async run() {
      const { pid, changed } = supervisor.ensure();

      const values = ctx.settings.get();
      const relayUrl = String(values.relayUrl ?? '').trim().replace(/\/+$/, '');
      // 换地址/口令后立刻重探，别让卡片显示上一台中转机的状态
      if (relayUrl !== relayProbedFor) {
        relay = null;
        relayProbedAt = 0;
        relayProbedFor = relayUrl;
      }
      const now = Date.now();
      if (now - relayProbedAt >= RELAY_PROBE_MS) {
        relay = await probeRelay(ctx);
        relayProbedAt = now;
      }

      published = publishStatus(ctx, dataDir, pid, relay, published);
      if (!changed) return;
      ctx.health.report({
        level: pid ? 'ok' : 'warn',
        message: pid ? `桥已启动（pid ${pid}）` : '桥未运行：已关闭或配置不完整',
      });
    },
  });

  // 常驻任务本身会被 manager 回收；这里额外保证进程一定被杀掉，
  // 因为「插件停了还有一个进程在外联」正是这套机制要消灭的东西。
  ctx.onDispose(() => {
    registration.dispose();
    supervisor.stop();
  });

  return supervisor;
}

/** 桥脚本的 mtime，供状态显示「装的是哪一版」。 */
export function bridgeScriptMtime(path: string | null): number | null {
  if (!path || !existsSync(path)) return null;
  try {
    return statSync(path).mtimeMs;
  } catch {
    return null;
  }
}

/** 读 lock 判断桥在不在跑，给 `mobile_relay doctor` 用（不启动任何东西）。 */
export function readBridgePid(dataDir: string | null): number | null {
  if (!dataDir) return null;
  const lockPath = join(dataDir, LOCK_NAME);
  if (!existsSync(lockPath)) return null;
  try {
    const parsed = JSON.parse(readFileSync(lockPath, 'utf8')) as Partial<LockRecord>;
    if (typeof parsed.pid !== 'number' || !isAlive(parsed.pid)) return null;
    return parsed.pid;
  } catch {
    return null;
  }
}
