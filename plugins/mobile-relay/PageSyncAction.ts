import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PluginContext } from '@packages/mica-plugin/index.js';
import { pageVersionOf, resolveRendererDir, syncPage } from './PageSync.js';

/**
 * 「中转机上的页面是不是当前这版」的**手动**更新。
 *
 * 页面产物跟着 Mica 的版本走，而中转机托管的是上一次部署时的那一份。所以配置页给一个
 * 按钮：算出版本号、和 `/api/health` 比一次，不一致才打包上传。
 *
 * 刻意不做定时检查：上传是 3MB 级的出网流量，什么时候传该由人决定，而不是让后台
 * 每十分钟替他决定一次。
 */

const STATE_NAME = 'page-sync.json';

export type PageSyncState = {
  /** 本机页面版本；找不到产物时为空。 */
  local: string;
  /** 中转机当前版本。 */
  remote: string;
  synced: boolean;
  text: string;
  tone: 'ok' | 'warn' | 'error';
  updatedAt: number;
};

function writePageSyncState(dir: string | null, state: PageSyncState): void {
  if (!dir) return;
  try {
    writeFileSync(join(dir, STATE_NAME), `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  } catch {
    // 状态写不进去不影响同步本身，下次点按钮会再写
  }
}

/** 一份「要不要传」的判断，独立于网络，便于单测。 */
export function describePageState(local: string, remote: string): Omit<PageSyncState, 'updatedAt'> {
  if (!local) {
    return { local: '', remote, synced: false, text: '本机没有页面产物', tone: 'warn' };
  }
  if (!remote) {
    return { local, remote: '', synced: false, text: `中转机未上报（本机 ${local}）`, tone: 'warn' };
  }
  if (local === remote) {
    return { local, remote, synced: true, text: `已同步 ${local}`, tone: 'ok' };
  }
  return { local, remote, synced: false, text: `落后（中转机 ${remote}，本机 ${local}）`, tone: 'warn' };
}

/** 页面产物目录的唯一解析处：状态行与按钮都读它，免得两处判断不一致。 */
export function rendererDirFor(ctx: PluginContext): string | null {
  const values = ctx.settings.get();
  return resolveRendererDir({
    explicit: String(values.rendererDir ?? '').trim() || undefined,
    env: process.env.MICA_DESKTOP_RENDERER,
    cwd: process.cwd(),
    repoRoot: ctx.paths?.home ? join(ctx.paths.home, '..') : undefined,
  });
}

/**
 * 跑一次同步。返回给配置页那句话（动作结果直接显示它）。
 *
 * 版本一致时不上传，把手机链接一并回给用户——点这个按钮的人通常就是要去开手机。
 */
export async function runPageSync(
  ctx: PluginContext,
  dataDir: string | null,
): Promise<{ ok: boolean; message: string; link?: string }> {
  const values = ctx.settings.get();
  const relayUrl = String(values.relayUrl ?? '').trim().replace(/\/+$/, '');
  const token = String(values.token ?? '').trim();
  if (!relayUrl || !token) {
    return { ok: false, message: '还没连接中转机：先在设置里填中转地址并注册这台机器' };
  }

  const dir = rendererDirFor(ctx);
  const local = pageVersionOf(dir) ?? '';
  const outcome = await syncPage({ relayUrl, token, rendererDir: dir });
  if (outcome.status === 'unsupported') {
    writePageSyncState(dataDir, {
      ...describePageState(local, ''),
      text: outcome.reason,
      updatedAt: Date.now(),
    });
    return { ok: false, message: outcome.reason };
  }

  if (outcome.status === 'published') {
    writePageSyncState(dataDir, {
      ...describePageState(outcome.version, outcome.version),
      text: `已更新到 ${outcome.version}（${(outcome.bytes / 1024 / 1024).toFixed(1)}MB）`,
      updatedAt: Date.now(),
    });
    return { ok: true, message: `中转机页面已更新到 ${outcome.version}` };
  }

  writePageSyncState(dataDir, {
    ...describePageState(outcome.version, outcome.version),
    updatedAt: Date.now(),
  });
  const phoneUrl = token.length >= 16 ? `${relayUrl}/?t=${encodeURIComponent(token)}` : '';
  return {
    ok: true,
    message: `已经是最新（${outcome.version}），手机端不用重传`,
    ...(phoneUrl ? { link: phoneUrl } : {}),
  };
}

