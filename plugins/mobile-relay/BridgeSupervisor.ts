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
    const child = spawn(nodeBin, [script], { detached: true, stdio: 'ignore', env: process.env });
    child.on('error', (error) => {
      ctx.logger.error('bridge:spawn-failed', { error: error instanceof Error ? error.message : String(error) });
    });
    child.unref();
    if (!child.pid) return null;
    writeFileSync(lockPath, JSON.stringify({ pid: child.pid, startedAt: Date.now() }), 'utf8');
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
    const values = ctx.settings.get();
    if (String(values.enabled ?? 'true') === 'false') {
      const stopped = stop();
      if (stopped) ctx.logger.info('bridge:stopped', { reason: 'disabled' });
      return { pid: null, changed: stopped };
    }
    // 没填地址/口令时不要拉起一个只会失败的进程；用户在页面上填好，下一轮自己就起来了。
    if (!String(values.relayUrl ?? '').trim() || !String(values.token ?? '').trim()) {
      stop();
      return { pid: null, changed: false };
    }
    const current = runningPid();
    if (current !== null) return { pid: current, changed: false };
    const started = start();
    if (started !== null) ctx.logger.info('bridge:started', { pid: started });
    return { pid: started, changed: true };
  };

  return { ensure, stop, runningPid, scriptPath: () => (dir ? join(dir, SCRIPT_NAME) : null) };
}

/**
 * 把监管注册成一个常驻任务。
 *
 * 15 秒一跳：桥自己会按有没有人在线退避，这里只负责「进程还在不在」，不需要更密。
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
  const registration = background.register({
    id: 'bridge',
    every: 15_000,
    immediate: true,
    async run() {
      const { pid, changed } = supervisor.ensure();
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
