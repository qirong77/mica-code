import type { PluginContext } from '@packages/mica-plugin/index.js';
import { commandHostToken } from '@packages/mica-builtin-commands/commandHost.js';
import type { CommandRuntimeServices } from '@packages/mica-builtin-commands/index.js';
import { ToolSessionPeers } from './SessionAutonomyTools.js';
import { formatSameCwdPeer, readPeerSnapshot, type SessionPeerDeps } from './sessionPeers.js';
import { installSessionWriteTracking } from './sessionWriteTracking.js';

const SESSION_AUTONOMY_GUIDANCE = `# 会话自治（Session Autonomy）

你可以通过以下工具观察当前会话：
- session_peers：查看正在运行的其他 Mica 实例及其 session 文件路径；同一工作目录的并发会话还会列出它本轮写过的文件。
  不确定一批未提交改动是不是自己的、发现文件内容与预期不符、或改动突然消失时用它，不要靠推断。
  传入 hours（如 6）还会列出最近 N 小时内结束的会话——它们已释放 turn 锁，但可能刚改过工作区。`;

/**
 * 同一个工作目录上还有别的会话在跑时的提醒。
 *
 * 这一段是**宿主主动**给的，不靠模型「怀疑了才去查」：真实事故里模型非常确信那些改动
 * 是自己的子代理写的，从头到尾没查过一次 `session_peers`。只写判断依据，不写教条。
 */
export function buildConcurrencyNotice(deps: SessionPeerDeps): string {
  const snapshot = readPeerSnapshot(deps);
  if (snapshot.sameCwd.length === 0) return '';
  const peers = snapshot.sameCwd.map((lock) => formatSameCwdPeer(lock)).join('\n');
  return `# 并发会话（同一工作目录）

这个工作目录上还有 ${snapshot.sameCwd.length} 个 Mica 会话正在跑：
${peers}

工作区不是本会话独占。\`git status\` / \`git diff\` 不记录作者，所以：
- 「本轮开始时 \`git status\` 是干净的」推不出「现在的改动都是我的或我子代理的」；
- 不确定归属就调 \`session_peers\`，它会列出每个并发会话本轮写过的文件；
- 不属于本次任务的改动只能报告（说清哪几处、疑似来自哪条会话），不能回滚、还原、重排或格式化整份文件。`;
}

export default function setupSessionAutonomy(ctx: PluginContext): void {
  const host = ctx.services.get(commandHostToken);
  if (!host) throw new Error('session-autonomy requires the builtin command host');
  const services: CommandRuntimeServices = host.services;
  const deps: SessionPeerDeps = { services };

  if (!ctx.tools) throw new Error('session-autonomy requires ctx.tools');
  const registration = ctx.tools.register(new ToolSessionPeers({ services }), { primaryAgentOnly: true });
  ctx.onDispose(() => registration.dispose());

  // 工具层写过的路径记进 per-session 台账，`session_peers` 才能回答「谁改的」。
  const writeTracking = installSessionWriteTracking(deps);
  ctx.onDispose(() => writeTracking.dispose());

  if (!ctx.prompt) throw new Error('SessionAutonomyPlugin requires ctx.prompt');
  const promptBuildDisposable = ctx.prompt.section({
    id: 'guidance',
    order: -200,
    render: () => SESSION_AUTONOMY_GUIDANCE,
  });
  ctx.onDispose(() => promptBuildDisposable.dispose());

  // 排在最末：内容随别的会话起落而变化，放在前缀里会连累前面稳定的段落一起失效。
  const concurrencyDisposable = ctx.prompt.section({
    id: 'concurrency',
    order: 1100,
    render: () => buildConcurrencyNotice(deps),
  });
  ctx.onDispose(() => concurrencyDisposable.dispose());
}
