/**
 * `/btw` 的命令行形态：参数解析与结果呈现。
 *
 * 与 `mica-builtin-commands/shared/btwThread.ts` 分开：那边是「旁问是什么」（提示词、
 * 背景记录），两端（TUI 命令与桌面端抽屉）必须一致；这里是「终端里怎么读参数、答案
 * 怎么排」，只有这条命令关心。
 */

export type BtwArgsParse = { question: string; isContinue: boolean } | null;

/** `/btw 问题` 或 `/btw -continue 追问`；空问题与只有 `-continue` 都算用法错误。 */
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

/**
 * 一条 btw 结果：原问题（引用块）+ 可选的「没有前文」说明 + 回答 + 继续追问的提示。
 *
 * `isFallback` 只在 `-continue` 找不到线程时给出——那时答案是当成新问题得到的，用户
 * 需要知道这一点，否则会以为模型忘掉了前文。
 */
export function formatBtwNotice(question: string, answer: string, isFallback = false): string {
  const fallback = isFallback ? ['', '_没有可延续的 btw 对话，已作为一条新问题处理_'] : [];
  return [`> ${question}`, ...fallback, '', answer, '', '── `/btw -continue` 继续与该 btw 对话 ──'].join('\n');
}
