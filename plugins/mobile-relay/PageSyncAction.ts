import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PluginContext, PluginNewSession } from '@packages/mica-plugin/index.js';
import { pageVersionOf, resolveRendererDir, syncPage } from './PageSync.js';

/**
 * 「中转机上的页面是不是当前这版」的**手动**更新。
 *
 * 页面产物跟着 Mica 的版本走，而中转机托管的是上一次部署时的那一份。所以配置页给一个
 * 按钮：算出版本号、和 `/api/health` 比一次，不一致才打包上传。
 *
 * 点按钮的人拿到的不是「传完了」，而是一段**给 agent 的提示词**（`guidePageSync`）：开一个
 * 新会话、把提示词摆进输入框，发不发送由用户决定。这一步看似绕，但版本比对、产物缺失时要不要
 * 重新构建、上传失败是证书还是口令，都得现场判断——交给会话里的 agent 比在按钮里写死几条
 * if 更靠得住；真正的上传仍然只有 `runPageSync` 一份实现，agent 经 `mobile_relay` 工具调用它。
 *
 * 上传永远是手动的一步：一次 3MB 级的出网流量，什么时候传该由人决定。后台只做**版本的
 * 只读比较**（`/api/health` 那一个请求），落后时把「有一件事等人点一下」上报成
 * `data.json` 的 `attention`——侧栏 Plugins 入口、插件卡片与面板据此显示提示点与更新按钮。
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

/**
 * 按钮/提示点要开的那一轮：把这件活交给会话里的 agent。
 *
 * 提示词要能独立成立——接手的是一个新会话，它看不到这里的状态，也看不到用户刚才点了什么。
 */
const PAGE_SYNC_PROMPT = [
  '手机端页面落后了：把中转机上托管的那份换成这台机器当前的版本。',
  '',
  '1. 调 `mobile_relay` 工具，action = sync_page。它算本机页面版本、和中转机的 /api/health 比一次，',
  '   一致就直接回「已经是最新」，不一致才打包上传（3MB 级，一次就够）。',
  '2. 如果它报「本机没有页面产物」，说明这台机器上没有可发布的构建：在仓库里跑',
  '   `cd apps/desktop && npx electron-vite build` 之后重跑第 1 步。不要为此重新部署中转机',
  '   （`setup.mjs --redeploy` 是另一件事，页面更新用不到 SSH）。',
  '3. 把版本号变化和手机链接回给我，并说明手机上刷新一下就是新版。',
  '',
  '细节在 skill `mobile-relay` 里。只做这一件事，别顺手改别的配置。',
].join('\n');

/**
 * 动作的产出是「一段提示词 + 一个新会话」。
 *
 * `send: false`：宿主把提示词摆进新会话的输入框就停下，发不发送由用户按回车决定——插件不该
 * 替人按下发送键。
 */
export function guidePageSync(): { newSession: PluginNewSession } {
  return { newSession: { prompt: PAGE_SYNC_PROMPT, send: false } };
}

