import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { PluginContext } from '@packages/mica-plugin/index.js';
import { DEPLOY_FILES } from './deploySource.js';

/**
 * 在插件里跑 `setup.mjs`：接入或部署中转机，用户不用去命令行敲。
 *
 * 脚本和执行器都随包内嵌，运行时落盘到插件自己的数据目录；页面产物不内嵌（那是一份
 * 会随桌面端升级而过期的副本），所以**首次部署**还需要一个构建产物目录，缺了就把话
 * 说清楚、别假装能跑。
 */

const BUNDLE_DIR = 'bundle';
const STATE_NAME = 'deploy.json';

export type DeployPhase = 'idle' | 'running' | 'ok' | 'failed';

export type DeployState = {
  phase: DeployPhase;
  /** 上一次动作是不是一次 setup（接入与部署走同一个脚本，由脚本自己判断）。 */
  mode: 'setup' | null;
  startedAt: number;
  finishedAt: number;
  /** 最近若干行输出，供面板显示进度。 */
  lines: string[];
};

const EMPTY: DeployState = { phase: 'idle', mode: null, startedAt: 0, finishedAt: 0, lines: [] };

/** 把随包的 setup.mjs 与 relay 三件套写到 `bundle/`，结构要和仓库里一致。 */
export function materializeBundle(dataDir: string): string {
  const dir = join(dataDir, BUNDLE_DIR);
  for (const [relative, content] of Object.entries(DEPLOY_FILES)) {
    const target = join(dir, relative);
    mkdirSync(dirname(target), { recursive: true });
    // 内容没变就不重写：失败重试时别把 mtime 搅乱
    try {
      if (readFileSync(target, 'utf8') === content) continue;
    } catch {
      // 还没有，写就是了
    }
    writeFileSync(target, content, 'utf8');
  }
  return join(dir, 'setup.mjs');
}

export function readDeployState(dataDir: string | null): DeployState {
  if (!dataDir) return { ...EMPTY };
  try {
    const parsed = JSON.parse(readFileSync(join(dataDir, STATE_NAME), 'utf8')) as Partial<DeployState>;
    return {
      phase: parsed.phase === 'running' || parsed.phase === 'ok' || parsed.phase === 'failed' ? parsed.phase : 'idle',
      mode: parsed.mode === 'setup' ? 'setup' : null,
      startedAt: Number(parsed.startedAt) || 0,
      finishedAt: Number(parsed.finishedAt) || 0,
      lines: Array.isArray(parsed.lines) ? parsed.lines.filter((line) => typeof line === 'string').slice(-12) : [],
    };
  } catch {
    return { ...EMPTY };
  }
}

export type DeployRequest = {
  /** SSH 目标，如 `root@1.2.3.4`。 */
  host: string;
  sshPort?: string;
  /** 这台机器的显示名，中转机清单里用来认领口令。 */
  label?: string;
  /**
   * 首次部署需要的页面产物目录。接入已有中转机时用不到。
   * 空串表示「不提供」——脚本会报错并说明先构建。
   */
  renderer?: string;
};

/** 只接受 `用户@主机` 或纯主机名，避免把用户输入拼进 shell 之外的奇怪东西。 */
export function normalizeHost(input: string): string {
  const value = input.trim();
  if (!value) return '';
  return /^[A-Za-z0-9._@:-]+$/.test(value) ? value : '';
}

/**
 * 跑一次 setup.mjs。
 *
 * 返回的 Promise 在子进程结束时 resolve；进度通过 `onLine` 回调，同时落盘到
 * `deploy.json`，这样面板刷新时能看到进展而不是一片空白。
 */
export function runSetup(
  ctx: PluginContext,
  dataDir: string,
  request: DeployRequest,
  onState: (state: DeployState) => void,
): Promise<DeployState> {
  const host = normalizeHost(request.host);
  if (!host) {
    const state: DeployState = { ...EMPTY, phase: 'failed', lines: ['SSH 目标不合法，写成 root@1.2.3.4'] };
    persist(dataDir, state);
    onState(state);
    return Promise.resolve(state);
  }

  const script = materializeBundle(dataDir);
  const args = [script, '--host', host];
  if (request.sshPort?.trim()) args.push('--ssh-port', request.sshPort.trim());
  if (request.label?.trim()) args.push('--label', request.label.trim());
  if (request.renderer?.trim()) args.push('--renderer', request.renderer.trim());

  const state: DeployState = { phase: 'running', mode: 'setup', startedAt: Date.now(), finishedAt: 0, lines: [] };
  persist(dataDir, state);
  onState(state);

  const nodeBin = process.env.MICA_BRIDGE_NODE || 'node';
  const child = spawn(nodeBin, args, { cwd: dataDir, env: process.env, detached: process.platform !== 'win32' });
  let finished = false;
  const closed = new Promise<void>((resolve) => child.once('close', () => resolve()));
  ctx.onDispose(async () => {
    if (finished) return;
    const terminate = (signal: NodeJS.Signals) => {
      try {
        // setup 的 SSH 子进程也必须收掉，否则插件停用后部署仍会继续。
        if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, signal);
        else child.kill(signal);
      } catch {
        child.kill(signal);
      }
    };
    terminate('SIGTERM');
    const timer = setTimeout(() => terminate('SIGKILL'), 3_000);
    try {
      await closed;
    } finally {
      clearTimeout(timer);
    }
  });

  const push = (chunk: string) => {
    if (finished) return;
    for (const raw of chunk.split('\n')) {
      const line = raw.trimEnd();
      if (!line.trim()) continue;
      state.lines = [...state.lines, line].slice(-12);
    }
    persist(dataDir, state);
    onState({ ...state });
  };

  child.stdout?.on('data', (data: Buffer) => push(data.toString('utf8')));
  child.stderr?.on('data', (data: Buffer) => push(data.toString('utf8')));

  return new Promise((resolve) => {
    child.on('error', (error) => {
      if (finished) return;
      finished = true;
      state.phase = 'failed';
      state.finishedAt = Date.now();
      state.lines = [...state.lines, `启动失败：${error.message}`].slice(-12);
      persist(dataDir, state);
      onState(state);
      resolve(state);
    });
    child.on('close', (code) => {
      if (finished) return;
      finished = true;
      state.phase = code === 0 ? 'ok' : 'failed';
      state.finishedAt = Date.now();
      if (code !== 0) state.lines = [...state.lines, `退出码 ${code}`].slice(-12);
      persist(dataDir, state);
      onState(state);
      ctx.logger.info('mobile-relay:deploy-finished', { code, mode: state.mode });
      resolve(state);
    });
  });
}

function persist(dataDir: string, state: DeployState): void {
  try {
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(join(dataDir, STATE_NAME), `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  } catch {
    // 写不进去不影响部署本身，面板显示旧状态而已
  }
}

/**
 * 找页面产物目录：显式参数 → 环境变量 → 仓库里的构建结果。
 *
 * 打包后的应用把产物放在 app.asar 里，普通 node 进程读不出来；这里不猜路径，
 * 找不到就让首次部署走「让 agent 构建」那条路。
 */
export function findRendererDir(explicit: string): string | null {
  const looksRight = (dir: string) => Boolean(dir) && existsSync(join(dir, 'index.html'));
  for (const candidate of [explicit, process.env.MICA_DESKTOP_RENDERER || '']) {
    if (looksRight(candidate)) return candidate;
  }
  const fromRepo = join(process.cwd(), 'apps', 'desktop', 'out', 'renderer');
  return looksRight(fromRepo) ? fromRepo : null;
}
