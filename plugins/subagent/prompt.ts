/**
 * 委派策略：什么时候该用子代理、怎么划分任务、结果怎么处理。
 *
 * 参数细节（operation、context_mode、owned_paths、后台与等待的用法）留在 `agent`
 * 工具描述里，这里只说策略——两边都写一遍的话，改一处忘另一处就会自相矛盾。
 *
 * 分成两种倾向是有意的：同一份模型在「自己写代码」和「只做编排」两种场景下需要的
 * 委派意愿正好相反。默认 `proactive`（与历史行为一致），`on-request` 给「用户自己
 * 盯着改、不希望模型另开子代理」的场景用；两者只在第一条上不同，其余约束通用。
 */
export type DelegationMode = 'proactive' | 'on-request';

const MODE_OPENERS: Record<DelegationMode, string[]> = {
  proactive: [
    '- 多项任务并存，或当前任务能拆成独立子任务时，优先考虑用 subagent 并行推进，而不是在一个 turn 里串行做完；功能模块相对独立、边界清晰的开发任务尤其适合委派。',
  ],
  'on-request': [
    '- 除非用户、AGENT.md 或 skill 明确要求分工或并行，否则自己完成，不要主动开 subagent。',
    '- 被要求委派时，下面这些形状最适合拆出去，其余情况仍以自己做完为准。',
  ],
};

const SHARED_BULLETS = [
  '- 适合委派：独立模块/包/目录的实现，跨多个文件的调研与搜证，独立的测试编写或验证，方案对比与代码审阅。',
  '- 不适合委派：需求模糊需要边做边澄清，单文件微改，必须共享同一处可变状态的连续操作。',
  '- 按文件或目录划分所有权，明确每个子代理的可写范围，不要安排两个 subagent 同时写同一批文件。',
  '- 告诉子代理它并不独占代码库：不要回滚、重排或格式化自己租约之外的改动。',
  '- 委派描述要自包含：目标、约束、相关文件路径和验证方式都写清楚，不要让 subagent 反过来推断父代理的上下文。',
  '- 不要为了并行把任务切得过碎。',
  '- 收到结果后自己核对再交付：关键结论与实际的文件内容、测试输出一致，不要把 subagent 的汇报直接当成最终答案。',
  '- 子代理失败或部分完成时，先核对原因和已有成果；不要盲目重试用户主动停止的任务。再次委派写入前，确认旧任务已结束并检查现有改动，避免重复写入或覆盖。',
];

export function buildDelegationGuidance(mode: DelegationMode = 'proactive'): string {
  return ['# Subagent 委派', '', ...MODE_OPENERS[mode], ...SHARED_BULLETS].join('\n');
}

export const DELEGATION_GUIDANCE = buildDelegationGuidance('proactive');
