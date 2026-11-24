import { clip } from './views.js';

export type SidecarIssueInput = {
  parentId: string | null;
  parentTitle?: string;
  task: string;
};

/** 把一次派发变成子会话的第一条用户消息；后续 send 不重复包装。 */
export function buildSidecarIssuePrompt(input: SidecarIssueInput): string {
  const task = input.task.trim();
  const parentTitle = clip(input.parentTitle?.trim() || '未命名会话', 120);
  const parentId = input.parentId?.trim() || '未落盘';
  return [
    '<context>',
    `父会话：${parentTitle}`,
    `父会话 ID：${parentId}`,
    '</context>',
    '<task>',
    task,
    '</task>',
    '',
    '这是父会话派发给你的一个 issue。请围绕 <task> 执行，完成后汇报结果、改动和实际验证情况。',
  ].join('\n');
}
