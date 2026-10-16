import type { AgentUsageRecord } from '@packages/mica-agent/index.js';
import type { CommandAgent } from '../services.js';

/**
 * btw（By The Way）里与「谁显示回答」无关的部分：背景记录的取法、系统提示词、
 * 隔离子代理，以及线程（可复用的子代理 + 已记账请求数）。
 *
 * 单独成文件是因为有两类消费者，而它们的依赖必须分开：
 * - CLI 的 `/btw`（`./btw.ts`）经 `mica-ui` 显示 notice —— 会拖进 Ink/React；
 * - `mica app-server` 的 btw 面板（`apps/cli/src/runtime/btwThread.ts`）在 headless
 *   进程里跑，**不能**拉 Ink 进来，只能从本文件取这些纯逻辑。
 *
 * 背景记录、提示词与工具开关两边必须一致，所以只有这一处实现。
 */

export type BtwSubagent = {
  query(input: string): Promise<string>;
  readonly usageHistory?: AgentUsageRecord[];
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

export type BtwArgsParse = { question: string; isContinue: boolean } | null;

export function parseBtwArgs(rawArgs: string): BtwArgsParse {
  const trimmed = rawArgs.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith('-continue')) {
    const question = trimmed.slice('-continue'.length).trim();
    if (!question) return null;
    return { question, isContinue: true };
  }
  return { question: trimmed, isContinue: false };
}

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

export function buildBtwSystemPrompt(transcript: string): string {
  const summary = transcript
    ? `\n\n以下是用户在主流程中的对话记录（仅作背景参考，不要据此展开或帮忙实现主流程的任务）：\n\n${transcript}`
    : '';
  return [
    '当前是 btw（by the way）模式。',
    '用户可能在主流程中正编写代码或执行任务，但本对话只处理 btw 的问题。',
    '你不需要考虑或帮助主流程的实现，不要调用主流程的状态，也不要写回主流程对话。',
    '围绕用户提出的 btw 问题给出清晰、直接的回答即可；可以用只读工具（读文件 / 搜索 / 联网）来支撑回答。',
    summary,
  ].join('\n');
}

export function formatBtwNotice(question: string, answer: string, isFallback = false): string {
  const fallback = isFallback ? ['', '_没有可延续的 btw 对话，已作为一条新问题处理_'] : [];
  return [`> ${question}`, ...fallback, '', answer, '', '── `/btw -continue` 继续与该 btw 对话 ──'].join('\n');
}

function createBtwSubagent(agent: CommandAgent, transcript: string): BtwSubagent {
  return agent.createSubAgent({
    systemPrompt: buildBtwSystemPrompt(transcript),
    tools: true,
  });
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
