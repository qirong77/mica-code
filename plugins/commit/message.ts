import type { PluginLlmApi } from '@packages/mica-plugin/index.js';

/**
 * commit message 的模型请求。
 *
 * 只发一次「system + user → 文本」，没有工具、没有多轮、没有流式：这里要的是一条确定
 * 的消息，任何额外能力都只会让失败面变大。请求交给 `ctx.llm`：接口配置、协议分支、
 * envelope 拼接与用量记账都只有一份实现，这笔开销也会出现在会话的 Stats 里。
 */

export const DEFAULT_PROMPT = [
  'You write concise git commit messages.',
  'Return only the commit message, with no markdown fences and no explanation.',
  'Choose exactly one format category from: feat, fix, refactor, chore, docs, test, perf, style, build, ci.',
  'Use this subject format: type: 中文摘要 emoji',
  'Put only the plain type before the colon; put the emoji at the end.',
  'Examples:',
  'feat: 开发了提交插件 ✨',
  'fix: 修复模型配置读取失败 🐛',
  'refactor: 简化 agent 运行时配置 ♻️',
  'chore: 更新项目配置 🔧',
  'Keep the subject under 72 characters.',
  'Add a short Chinese body only if it materially clarifies multiple changes.',
  'Do not include step-by-step reasoning.',
].join('\n');

export type MessageRequestConfig = {
  prompt: string;
  /** 覆盖模型（设置里单独写了模型名时）；不填用 `ctx.llm` 生效的模型。 */
  model?: string;
  timeoutMs?: number;
};

export const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;

export class CommitMessageError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'CommitMessageError';
  }
}

export async function requestCommitMessage(
  llm: PluginLlmApi,
  config: MessageRequestConfig,
  summary: string,
): Promise<string> {
  try {
    const result = await llm.request({
      purpose: '写提交说明',
      system: config.prompt,
      user: buildUserMessage(summary),
      model: config.model,
      timeoutMs: config.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
    });
    return sanitizeCommitMessage(result.text);
  } catch (error) {
    if (error instanceof CommitMessageError) throw error;
    const message = error instanceof Error ? error.message : String(error);
    throw new CommitMessageError(`commit message 请求无法完成：${message}`);
  }
}

/** 模型偶尔会把 message 包在代码块里，或带上一句解释；这里只留提交信息本身。 */
export function sanitizeCommitMessage(response: string): string {
  // 模型偶尔整段包在 ``` 里（有时带语言标记，前面还可能有空行），先摘掉这层壳。
  const unwrapped = response.replace(/^\s*```[^\n]*\n/, '').replace(/\n?```\s*$/, '');
  const lines = unwrapped.split('\n').map((line) => line.trimEnd());

  while (lines.length && !lines[0]?.trim()) lines.shift();
  while (lines.length && !lines.at(-1)?.trim()) lines.pop();

  const message = lines.join('\n').trim();
  if (!message) return 'chore: 更新项目文件 🔧';
  return message;
}

function buildUserMessage(summary: string): string {
  return [
    'Create a git commit message for these changes.',
    'The diff is intentionally summarized and sampled, so infer conservatively.',
    '',
    summary,
  ].join('\n');
}
