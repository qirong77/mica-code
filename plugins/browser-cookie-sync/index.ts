import { join } from 'node:path';
import { resolveMicaHome } from '@packages/mica-config/index.js';
import type { PluginContext } from '@packages/mica-plugin/index.js';
import { createPanelHandler } from './panel.js';
import { findBrowser } from './chrome/profiles.js';
import { SyncFailure, locateChrome, performSync, resolveSyncOptions, type SyncOptions } from './run.js';
import { mutateState, readState, stateFilePath } from './state.js';
import {
  describeCounts,
  describeLastRun,
  updatePluginData,
  type Attention
} from './status.js';

const PLUGIN_ID = 'browser-cookie-sync';
const DEFAULT_AUTO_MINUTES = 0;

/**
 * `browser-cookie-sync`：把用户自己的 Chrome 与 Mica 的受控浏览器之间的 cookie **双向**同步。
 *
 * 三段数据流各自有边界：
 * - Chrome 侧是这个插件自己干的（系统 `sqlite3` 读写它的 cookie 库 + 钥匙串里的
 *   `Chrome Safe Storage` 解密），所以「谁在同步、同步了什么」都看得见；
 * - 受控浏览器侧走宿主的 HTTP 接口（`MICA_BROWSER_URL`）：这个插件跑在子进程里，碰不到
 *   Electron 的分区，也不该自己去改它正在用的库；
 * - 判断「是谁变了」靠插件自己的基线（`state.json`，只存指纹不存值）。
 *
 * 只有桌面端有受控浏览器，所以清单里声明了 `requires: ["desktop"]`；配置页的按钮走
 * `mica plugin-action` 的一次性进程（那里 `ignoreRequirements`），不需要会话。
 */

export default function setup(ctx: PluginContext): void {
  const dataDir = join(ctx.paths?.config ?? resolveMicaHome(), 'plugin-data', ctx.pluginId ?? PLUGIN_ID);
  const stateFile = stateFilePath(dataDir);

  /** 设置文件 + 页面上还没落盘的草稿（面板动作与配置页按钮都会带 values）。 */
  const resolveOptions = (values: Record<string, string> = {}): SyncOptions =>
    resolveSyncOptions({ ...ctx.settings.get(), ...values });

  const autoMinutes = (): number => {
    const value = Number(ctx.settings.get().everyMinutes ?? DEFAULT_AUTO_MINUTES);
    return Number.isFinite(value) && value > 0 ? value : 0;
  };

  /**
   * 跑一轮并把结果落到状态 / 基线 / 健康状态。
   *
   * 成功就清掉上一次的错误上报（否则「连不上」会一直挂在插件卡片上），失败按可行动的四类
   * 分开讲：没授权、钥匙串被拒、没有配置文件、受控浏览器不在。
   */
  async function syncOnce({
    dryRun,
    values = {},
    resolve
  }: {
    dryRun: boolean;
    values?: Record<string, string>;
    resolve?: { key: string; side: 'chrome' | 'mica' };
  }): Promise<{ message: string }> {
    const options = resolveOptions(values);
    const state = readState(stateFile);
    try {
      const outcome = await performSync({
        options,
        baseline: state.baseline,
        dryRun,
        ...(resolve ? { resolve } : {})
      });
      if (!dryRun) {
        await mutateState(stateFile, (current) => ({
          version: current.version,
          updatedAt: new Date().toISOString(),
          baseline: outcome.baseline,
          lastRun: outcome.lastRun
        }));
      }
      updatePluginData(dataDir, {
        target: { text: `${outcome.target.browser.label} · ${outcome.target.profileDir}`, tone: 'ok' },
        lastRun: describeLastRun({ ...state, lastRun: outcome.lastRun }),
        counts: describeCounts({ ...state, lastRun: outcome.lastRun }),
        access: accessLine(outcome.target.cookiesPath ? 'granted' : 'denied'),
        profiles: outcome.target.profiles.map((profile) => ({ dir: profile.dir, name: profile.name })),
        conflicts: outcome.lastRun.conflicts,
        notes: outcome.lastRun.notes,
        options: { ...pickOptions(options) },
        // 成功过一轮就说明钥匙串与权限都通了：撤掉那条「去授权」的提示
        attention: null
      });
      ctx.health.clear();
      return { message: outcome.message };
    } catch (error) {
      const failure = asFailure(error);
      const attention: Attention =
        failure.code === 'no-keychain' || failure.code === 'no-access'
          ? { text: failure.message, tone: 'error', action: 'sync' }
          : null;
      updatePluginData(dataDir, {
        target: { text: findBrowser(resolveOptions(values).browserId).label, tone: 'error' },
        lastRun: { text: failure.message, tone: 'error' },
        access: accessLine(failure.code === 'no-access' ? 'no-access' : 'unknown'),
        attention
      });
      ctx.health.report({
        level: 'error',
        message: failure.message,
        ...(failure.hint ? { hint: failure.hint } : {})
      });
      ctx.logger.warn('browser-cookie-sync:failed', { code: failure.code, message: failure.message });
      throw failure;
    }
  }

  const actions = ctx.actions;
  if (actions) {
    actions.register('sync', async ({ values }) => {
      try {
        return { message: (await syncOnce({ dryRun: false, values: pickValues(values) })).message };
      } catch (error) {
        return { message: failureMessage(error) };
      }
    });
    actions.register('preview', async ({ values }) => {
      try {
        return { message: (await syncOnce({ dryRun: true, values: pickValues(values) })).message };
      } catch (error) {
        return { message: failureMessage(error) };
      }
    });
  }

  const panel = ctx.desktop?.panel;
  if (panel) {
    panel.call(
      ctx.desktop,
      createPanelHandler({
        dataDir,
        settings: () => ctx.settings.get() as Record<string, string>,
        saveSettings: (values) => {
          ctx.settings.set(values);
        },
        sync: async (input) =>
          syncOnce({
            dryRun: input.dryRun,
            ...(input.resolve ? { resolve: input.resolve } : {})
          })
      })
    );
  }

  // 自动同步默认关着（`everyMinutes` = 0）：把用户所有站点的凭证每 5 分钟搬一遍，不该是
  // 装上就发生的事。打开之后间隔由设置决定，改设置立刻生效（每轮重新读）。
  ctx.background?.register({
    id: 'auto-sync',
    every: () => {
      const minutes = autoMinutes();
      return Math.max(60_000, minutes * 60_000);
    },
    ...(autoMinutes() > 0 ? { immediate: false } : {}),
    async run() {
      if (autoMinutes() <= 0) return;
      try {
        await syncOnce({ dryRun: false });
      } catch {
        // 失败已经写进健康状态与 attention，这一轮到此为止（下一轮再试）
      }
    }
  });

  // 首次装配时把「能不能同步」先探一次：没授权时用户一打开面板就该看到原因，
  // 而不是点完按钮才知道。只读文件系统，不问钥匙串（那可能弹授权）。
  try {
    const target = locateChrome(resolveOptions());
    updatePluginData(dataDir, {
      target: target.problem
        ? { text: `${target.browser.label}：${target.problem}`, tone: 'error' }
        : { text: `${target.browser.label} · ${target.profileDir}`, tone: 'ok' },
      profiles: target.profiles.map((profile) => ({ dir: profile.dir, name: profile.name })),
      access: target.problem ? accessLine('no-access') : accessLine('granted')
    });
  } catch (error) {
    ctx.logger.warn('browser-cookie-sync:locate-failed', {
      message: error instanceof Error ? error.message : String(error)
    });
  }

  ctx.logger.info('browser-cookie-sync:ready', { dataDir, autoMinutes: autoMinutes() });
}

function pickOptions(options: SyncOptions): Record<string, string> {
  return {
    browser: options.browserId,
    profile: options.profileDir,
    toMica: options.toMica ? 'true' : 'false',
    toChrome: options.toChrome ? 'true' : 'false',
    writeWhileRunning: options.writeWhileRunning ? 'true' : 'false'
  };
}

function accessLine(state: 'granted' | 'denied' | 'no-access' | 'unknown'): {
  text: string;
  tone: 'ok' | 'warn' | 'error';
} {
  switch (state) {
    case 'granted':
      return { text: '全磁盘访问已开，钥匙串可用', tone: 'ok' };
    case 'no-access':
      return {
        text: '读不到 Chrome 的数据：给 Mica 打开「全磁盘访问」后重启应用',
        tone: 'error'
      };
    case 'denied':
      return { text: '权限不完整', tone: 'warn' };
    default:
      return { text: '尚未探测', tone: 'warn' };
  }
}

function asFailure(error: unknown): SyncFailure {
  if (error instanceof SyncFailure) return error;
  return new SyncFailure('unknown', error instanceof Error ? error.message : String(error));
}

function failureMessage(error: unknown): string {
  const failure = asFailure(error);
  return failure.hint ? `${failure.message}（${failure.hint}）` : failure.message;
}

/** 面板 / 配置页送来的值里只有声明过的键有用，其余（宿主自己加的）丢掉。 */
function pickValues(values: Record<string, unknown> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!values) return out;
  for (const key of ['browser', 'profile', 'toMica', 'toChrome', 'writeWhileRunning', 'everyMinutes']) {
    const value = values[key];
    if (value !== undefined) out[key] = String(value);
  }
  return out;
}
