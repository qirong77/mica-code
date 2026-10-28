import {
  formatSkillsIndex,
  micaAgent,
  type AgentQueryContent,
  type AgentUsageRecord,
} from '@packages/mica-agent/index.js';
import { micaTools } from '@packages/mica-tools/index.js';
import type { Skill } from '@packages/mica-skills/index.js';
import type { CommandAgent } from '../services.js';

/**
 * btw（By The Way）里与「谁显示回答」无关的部分：背景记录的取法、系统提示词，以及
 * 常驻 host 用的线程（可复用的子代理 + 已记账请求数）。
 *
 * 有两类消费者，依赖必须分开：
 * - 官方插件 `plugins/btw`（CLI 的 `/btw`）只取提示词与记录整理，子代理由
 *   `ctx.subagents.thread` 建 —— 走插件能力面，不碰这一层的 `CommandAgent`；
 * - `mica app-server` 的 btw 面板（`apps/cli/src/runtime/btwThread.ts`）在 headless
 *   进程里跑，**不能**拉 Ink 进来，用这里的 `createBtwThread`。
 *
 * 背景记录与提示词两边必须一致（同一个旁问语义），所以只有这一处实现。
 */

export type BtwSubagent = {
  /** 纯文本，或文本 + 图片的多模态内容块（桌面端 By The Way 的粘贴图片）。 */
  query(input: AgentQueryContent, options?: { signal?: AbortSignal }): Promise<string>;
  /**
   * 中断后把「问题 + 已经流出的部分回答」补回子代理历史。
   *
   * 被 abort 的那一轮可能一次迭代都没提交，消息数组里没有这次的用户消息；
   * 不补的话，下一次追问时模型看不到上一次问过什么（主对话走的是同一条路径）。
   */
  preserveAbortedTurn?(question: AgentQueryContent, partialAnswer?: string): boolean;
  readonly usageHistory?: AgentUsageRecord[];
  /** 最近一次请求的用量：抽屉用它显示这条线程的上下文占用（与主对话同一口径）。 */
  readonly lastUsage?: AgentUsageRecord;
  /**
   * 子代理自己的消息数组（真实对象是 `IAgent`，`CommandAgent.createSubAgent` 的
   * 声明类型没有收进来）。`mica/btw/compact` 的本地压缩要读改写它——btw 线程的
   * 历史只活在这个子代理里，没有别的地方可以压。
   */
  getSnapshot?(): { messages: unknown[] };
  loadSnapshot?(snapshot: unknown): void;
  /**
   * 流式回调（可选设置）：思考 / 工具调用 / 正文的 delta。
   *
   * 只有桌面端的 By The Way 抽屉会挂上它们（把一次回答按主对话那套实时渲染出来）；
   * CLI 的 `/btw` **刻意不挂**：终端里只有一条 notice，实时刷思考/工具行没有表达空间，
   * 挂了只会多推一堆没人看的数据。所以不挂时这条路径的行为与从前完全一致。
   */
  onText?: (text: string) => void;
  onThinking?: (thinking: string) => void;
  onToolCall?: (name: string, args: string, id?: string) => void;
  onToolResult?: (name: string, result: string, id?: string) => void;
};

/** 一条 btw 线程：可复用（`-continue` / 面板里追问）的隔离子代理 + 已记账的请求数。 */
export type BtwThread = { subagent: BtwSubagent; recordedRequests: number };

/** 主流程当前角色的提示词：名字 + `$MICA_HOME/role/*.md` 原文（default 是内置模板）。 */
export type BtwRoleContext = { name: string; prompt: string };

export type BtwPromptContext = {
  /** 主流程当前角色；btw 的 system prompt 会把它整段嵌进去。 */
  role?: BtwRoleContext;
  /** skills 索引的输入；不传等价于「当前已加载的 skills」（与主流程一致）。 */
  skills?: Skill[];
};

/** 把模型消息里纯 user/assistant 的文本对话，按顺序整理成可读的「对话记录」。 */
export function messagesToTranscript(messages: unknown[]): string {
  const sections: string[] = [];
  for (const message of messages) {
    if (!message || typeof message !== 'object') continue;
    const record = message as Record<string, unknown>;
    const role = record.role;
    if (role !== 'user' && role !== 'assistant') continue;
    const text = extractMessageText(record.content);
    if (!text) continue;
    sections.push(role === 'user' ? `用户：${text}` : `助手：${text}`);
  }
  return sections.join('\n\n');
}

function extractMessageText(content: unknown): string {
  if (typeof content === 'string') return content.trim();
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    const record = block as Record<string, unknown>;
    const type = record.type;
    if (type === 'text' || type === 'input_text' || type === 'output_text') {
      if (typeof record.text === 'string') parts.push(record.text);
    }
  }
  return parts.join('\n').trim();
}

/**
 * btw 的系统提示词。
 *
 * 它**替换**主流程的 system prompt（`createSubAgent` 的 `systemPrompt` 是整体覆盖，
 * 不叠加），所以主流程具备、而回答又真的需要的东西必须在这里显式补回来：
 * - 当前角色及其完整提示词（模型要知道自己以谁的规则在回答）；
 * - skills 索引（否则 `Skill` 工具在，但模型不知道有哪些 skill）；
 * - 主流程对话记录（只读背景，不进主上下文）。
 */
export function buildBtwSystemPrompt(transcript: string, context: BtwPromptContext = {}): string {
  const summary = transcript
    ? `以下是用户在主流程中的对话记录（仅作背景参考，不要据此展开或帮忙实现主流程的任务）：\n\n${transcript}`
    : '';
  return [
    [
      '当前是 btw（by the way）模式。',
      '用户可能在主流程中正编写代码或执行任务，但本对话只处理 btw 的问题。',
      '你不需要考虑或帮助主流程的实现，不要调用主流程的状态，也不要写回主流程对话。',
      '围绕用户提出的 btw 问题给出清晰、直接的回答即可；可以用工具（读文件 / 搜索 / 联网 / 执行命令）来支撑回答，但不要改动主流程的会话状态。',
    ].join('\n'),
    describeRole(context.role),
    describeSkills(context.skills),
    summary,
  ]
    .filter((section) => section.length > 0)
    .join('\n\n');
}

function describeRole(role?: BtwRoleContext): string {
  const name = role?.name?.trim();
  if (!name) return '';
  const head = `主流程当前使用的角色是 \`${name}\`。`;
  const prompt = role?.prompt?.trim();
  if (!prompt) return head;
  return [
    head,
    '以下是该角色的完整提示词。它描述主流程的行为规则，在这里只作为背景；与上面的 btw 模式规则冲突时，以 btw 模式规则为准。',
    `<role name="${name}">`,
    prompt,
    '</role>',
  ].join('\n');
}

function describeSkills(skills?: Skill[]): string {
  const listing = formatSkillsIndex(skills);
  if (!listing) return '';
  return [
    '以下是主流程可用的 skills（索引与主流程一致）；需要时用 Skill 工具读取完整说明。',
    '<skills>',
    listing,
    '</skills>',
  ].join('\n');
}

/**
 * btw 的工具边界：主会话专属工具（`session_*`、loop 等 `primaryAgentOnly`）不进 btw。
 *
 * btw 是主流程旁边的旁问线程，它在应用上下文里拿到的 `toolContext` 与主流程相同、
 * 没有 `taskId`，所以「session 工具只能由主 agent 调用」那道运行期护栏对它不生效。
 * 唯一可靠的做法是在**工具集**这一层就把它们排除掉——与 `Agent` 工具的子代理同一条
 * 边界（见 `apps/cli/src/agents/PluginSubagentHost.ts` 的 `buildSubagentToolFilter`）。
 * 其余工具（含 `Skill` 与 MCP）照旧可用：btw 的回答本来就要靠读文件 / 搜索 / 联网。
 */
export function btwToolFilter(toolName: string): boolean {
  return !micaTools.isPrimaryAgentOnly(toolName);
}

function createBtwSubagent(agent: CommandAgent, transcript: string): BtwSubagent {
  // 运行时返回的是 `IAgent`（带 getSnapshot/loadSnapshot/lastUsage），而
  // `CommandAgent.createSubAgent` 的声明只承诺 query + 用量 + 流式回调。
  return agent.createSubAgent({
    systemPrompt: buildBtwSystemPrompt(transcript, { role: btwRoleContext(agent) }),
    tools: true,
    toolFilter: btwToolFilter,
  }) as unknown as BtwSubagent;
}

/**
 * 主流程当前角色 + 它的完整提示词（`$MICA_HOME/role/<name>.md`，default 为内置模板）。
 *
 * 读不到（role 文件在会话中途被删）时只带名字：少一段背景总好过整条 btw 建不起来。
 * 其它命令（`/role`）也是同一个入口，两边不会各自解析一份。
 */
export function btwRoleContext(agent: CommandAgent): BtwRoleContext | undefined {
  const name = typeof agent.role === 'string' ? agent.role.trim() : '';
  if (!name) return undefined;
  return { name, prompt: micaAgent.roles.get(name)?.prompt ?? '' };
}

/**
 * 开一条 btw 线程：用主流程**当前**的文字对话记录当背景（只读，不进主上下文）。
 *
 * CLI 的 `/btw` 与桌面端的面板共用这一处构造——两边的差别只在「谁来显示回答」，
 * 系统提示词、工具开关与背景记录的取法必须一致。
 */
export function createBtwThread(agent: CommandAgent): BtwThread {
  return {
    subagent: createBtwSubagent(agent, messagesToTranscript(agent.getSnapshot().messages)),
    recordedRequests: 0,
  };
}
