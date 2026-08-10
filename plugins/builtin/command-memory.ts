import { homedir } from 'node:os';
import { join } from 'node:path';
import type { PluginContext } from '@packages/mica-plugin/index.js';

type SystemPromptBuildEvent = {
  runtime: unknown;
  prompt: string;
};

export default function setupCommandMemory(ctx: PluginContext): void {
  return; // 暂时禁用，避免误导用户
  const configDir = ctx.paths?.config ?? process.env.MICA_HOME ?? join(homedir(), '.mica');
  const sessionsDir = join(configDir, 'sessions');
  const guidance = buildMemoryGuidance(sessionsDir);

  const disposable = ctx.hooks.on<SystemPromptBuildEvent, { event: SystemPromptBuildEvent }>(
    'system-prompt:build',
    (event) => {
      return { event: { ...event, prompt: appendText(event.prompt, guidance) } };
    },
    { pluginId: ctx.pluginId, priority: 0, failPolicy: 'stop' },
  );
  ctx.onDispose(() => disposable.dispose());
}

function appendText(content: string, text: string): string {
  return `${content}\n\n${text}`;
}

function buildMemoryGuidance(sessionsDir: string): string {
  return `# 会话记忆（Memory）

你有跨会话记忆能力。当用户请求模糊、明显引用之前的工作、或本会话缺少所需上下文时（例如“继续 xxx”、“接着上次的改”、“之前我们讨论过…”），先查阅历史会话再作答。

## Session 文件格式

历史会话以 JSON 文件保存在 \`${sessionsDir}\`，文件名 \`<session-id>.json\`，大致结构：

- \`title\`：会话标题，可用来快速识别内容
- \`createdAt\` / \`updatedAt\`：创建与最后更新时间，按 \`updatedAt\` 排序可找到最近的会话
- \`cwd\`：该会话的工作目录
- \`turnState\`：\`completed\` / \`aborted\` / \`error\` / \`running\`，非 \`completed\` 表示上次未完成
- \`snapshot.history\`：provider 消息历史（user / assistant / tool 消息）
- \`snapshot.conversationMessages\`：UI 层对话消息（role + content），更适合快速了解对话内容

## 怎么读取

1. 先用 \`list_files\` 列出 \`${sessionsDir}\` 下的 \`*.json\` 文件，优先读取 \`updatedAt\` 最新的会话
2. 想按内容查找时，用 \`grep_search\` 在 \`${sessionsDir}\` 内搜索关键词（标题、cwd、对话内容）
3. 用 \`read_file\` 读取选中的 session 文件，优先看 \`snapshot.conversationMessages\`（或 \`snapshot.history\` 末尾几条消息）恢复上下文，并注意 \`cwd\` 和 \`turnState\`
4. session 文件可能很大，\`conversationMessages\` 位于文件靠后。不要一次性 \`read_file\` 整个文件（默认 200 行可能读不到尾部）：先用 \`grep_search\` 定位 \`conversationMessages\` 的行号，再用 \`read_file\` 的 \`offset\` / \`limit\` 从该位置分段读取；只读需要的片段，不要把整个文件塞进上下文
5. 只有确实缺失上下文时才读取；查不到相关会话时直接告诉用户，不要编造

## 怎么汇报（让用户看到模型的返回）

- 只要使用了历史会话，就在回答开头说明参考了哪个 session（标题 + 更新时间，必要时候补 id），例如“参考了会话《xxx》（updatedAt 2026-08-01 …）”
- 把该会话中与当前问题相关的历史回复（assistant 消息）的结论或关键内容摘录/概述出来，让用户看到恢复的是哪一段上下文
- 引用历史结论时要和当前事实核对；历史已过时或与现状冲突时，明确指出差异，不要直接沿用`;
}
