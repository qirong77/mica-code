import type { PluginContext } from '@packages/mica-plugin/index.js';
import { AgentTool } from './AgentTool.js';
import { BUILTIN_SUBAGENTS } from './definitions.js';
import { buildDelegationGuidance, type DelegationMode } from './prompt.js';

export { AgentTool } from './AgentTool.js';
export { BUILTIN_SUBAGENTS, DEFAULT_SUBAGENT_MAX_TURNS, getBuiltinSubagent } from './definitions.js';
export { parseRunManySpecs, planSubagentRuns } from './orchestration.js';
export { formatStructuredSubagentResult, parseStructuredSubagentResult } from './result.js';
export { DELEGATION_GUIDANCE } from './prompt.js';
export type { PlannedSubagentRun, SubagentRunSpec } from './orchestration.js';
export type { DelegationMode } from './prompt.js';
export type { StructuredSubagentResult } from './result.js';

/**
 * 子代理委派：插件提供策略，宿主提供机制。
 *
 * 三块能力都从这里接入，内核里没有一处写死子代理类型或 `agent` 工具的形状：
 *
 * - **类型**：`ctx.subagents.registerType()` 注册 7 种内置类型（工具白/黑名单、
 *   默认上下文、写策略、迭代上限）。停用插件，这些类型随之消失。
 * - **工具**：`agent`，参数整形与文案在插件里，建子代理 / 用量记账 / 路径租约 /
 *   完成回注在宿主的 `ctx.subagents` 后面。`primaryAgentOnly` 让它不进子代理的工具表。
 * - **prompt**：`delegation` 段落只说「什么时候委派、怎么分任务」，参数细节留给工具描述。
 */
export default function setup(ctx: PluginContext): void {
  const subagents = ctx.subagents;
  const tools = ctx.tools;
  const prompt = ctx.prompt;
  if (!subagents) throw new Error('subagent plugin requires ctx.subagents');
  if (!tools) throw new Error('subagent plugin requires ctx.tools');
  if (!prompt) throw new Error('subagent plugin requires ctx.prompt');

  for (const type of BUILTIN_SUBAGENTS) {
    const registration = subagents.registerType(type);
    ctx.onDispose(() => registration.dispose());
  }

  const tool = tools.register(new AgentTool(subagents), { primaryAgentOnly: true });
  ctx.onDispose(() => tool.dispose());

  const section = prompt.section({
    id: 'delegation',
    order: 100,
    // 每轮重新渲染：用户在配置页把倾向改成「仅按要求委派」后，下一轮就生效。
    render: () => buildDelegationGuidance(readDelegationMode()),
  });
  ctx.onDispose(() => section.dispose());

  ctx.logger.info('subagent:ready', { types: BUILTIN_SUBAGENTS.map((type) => type.name) });

  function readDelegationMode(): DelegationMode {
    return ctx.settings?.get().delegationMode === 'on-request' ? 'on-request' : 'proactive';
  }
}
