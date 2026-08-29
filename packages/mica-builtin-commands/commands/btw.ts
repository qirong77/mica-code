import { micaUi } from '@packages/mica-ui/index.js';
import type { CommandAgent, CommandRuntimeServices } from '../services.js';

/**
 * `/btw <question>` — 旁路提问。
 *
 * 它在一个隔离子代理里执行，不阻塞也不影响主流程：
 * - 子代理拿到「主流程用户/助手文字对话记录 + btw 模式约束」作为上下文；
 * - 结果以一条 conversation notice 呈现：运行中固定在输入框上方的命令面板
 *   （不被主流程回复顶掉，直到任务完成），完成后作为普通 notice 展示，并在
 *   末尾给出 `/btw -continue` 继续追问的提示。
 *
 * `agent.createSubAgent` 本身是可复用的隔离子代理，`/btw -continue` 复用同一
 * 个子代理来延续对话（它有之前的 btw 上下文）。
 */

/** 每个 btw 线程的可复用子代理，按 agent（会话）维度保存，用于 `-continue` 延续。 */
const btwThreads = new WeakMap<object, { subagent: { query(input: string): Promise<string> } }>();

export function createBtwCommand(agent: CommandAgent, services: CommandRuntimeServices) {
  return {
    name: 'btw',
    description: '旁路提问：用一个隔离子代理回答，不打扰主流程（用法：/btw 问题，/btw -continue 追问）',
    action: (args?: string) => {
      void runBtw(agent, services, args?.trim() ?? '');
    },
  } satisfies Parameters<typeof micaUi.dropdown.setQuickCommands>[0][number];
}

export async function runBtw(agent: CommandAgent, services: CommandRuntimeServices, rawArgs: string): Promise<void> {
  const parsed = parseBtwArgs(rawArgs);
  if (!parsed) {
    services.showNotice('用法：/btw <问题>，或在一条 btw 完成后用 /btw -continue <追问> 继续', undefined, {
      command: '/btw',
      status: 'info',
    });
    return;
  }

  const { question, isContinue } = parsed;

  let subagent = isContinue ? btwThreads.get(agent as object)?.subagent : undefined;
  if (isContinue && !subagent) {
    services.showNotice('没有可延续的 btw 对话，将作为一条新问题处理', undefined, {
      command: '/btw',
      status: 'info',
    });
  }
  if (!subagent) {
    subagent = createBtwSubagent(agent, messagesToTranscript(agent.getSnapshot().messages));
    btwThreads.set(agent as object, { subagent });
  }

  upsertBtwNotice(services, `> ${question}\n\n正在思考…`, 'running');

  try {
    const reply = await subagent.query(question);
    upsertBtwNotice(services, formatBtwNotice(question, reply), 'success');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    upsertBtwNotice(services, `> ${question}\n\nbtw 出错：${message}`, 'error');
  }
}

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

export function formatBtwNotice(question: string, answer: string): string {
  return [
    `> ${question}`,
    '',
    answer,
    '',
    '── `/btw -continue` 继续与该 btw 对话 ──',
  ].join('\n');
}

function createBtwSubagent(agent: CommandAgent, transcript: string): { query(input: string): Promise<string> } {
  return agent.createSubAgent({
    systemPrompt: buildBtwSystemPrompt(transcript),
    tools: true,
  });
}

function upsertBtwNotice(
  services: CommandRuntimeServices,
  content: string,
  status: 'running' | 'success' | 'error' | 'info',
): void {
  // 运行中固定在输入框上方的命令面板（同 /commit、/compact），避免被主流程
  // 回复顶掉；btw 子代理完成后把结果作为普通 conversation notice 发送出去。
  services.showNotice(content, undefined, {
    command: '/btw',
    status,
    ...(status === 'running' ? { surface: 'command_panel' as const } : {}),
  });
}
