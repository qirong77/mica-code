import { micaUi } from '@packages/mica-ui/index.js';
import type { CommandAgent, CommandRuntimeServices } from '../services.js';
import { recordHelperSubagentUsage } from '../subagentUsage.js';
import { createBtwThread, formatBtwNotice, parseBtwArgs, type BtwThread } from './btwThread.js';

/**
 * `/btw <question>` — 旁路提问（CLI 的显示侧）。
 *
 * 它在一个隔离子代理里执行，不阻塞也不影响主流程：
 * - 子代理拿到「主流程用户/助手文字对话记录 + btw 模式约束」作为上下文；
 * - 结果以一条 conversation notice 呈现：运行中固定在输入框上方的命令面板
 *   （不被主流程回复顶掉，直到任务完成），完成后作为普通 notice 展示，并在
 *   末尾给出 `/btw -continue` 继续追问的提示。
 *
 * 系统提示词、背景记录与子代理构造在 `./btwThread.ts`（桌面端 btw 面板共用同一份，
 * 它不能拉 Ink 进来，所以纯逻辑必须与这里的 notice 显示分开）。
 *
 * `agent.createSubAgent` 本身是可复用的隔离子代理，`/btw -continue` 复用同一
 * 个子代理来延续对话（它有之前的 btw 上下文）。
 */

export {
  buildBtwSystemPrompt,
  createBtwThread,
  formatBtwNotice,
  messagesToTranscript,
  parseBtwArgs,
} from './btwThread.js';
export type { BtwArgsParse, BtwSubagent, BtwThread } from './btwThread.js';

/**
 * 每个 btw 线程的可复用子代理，按 agent（会话）维度保存，用于 `-continue` 延续。
 * `recordedRequests` 记下已经写进会话用量的请求数，`-continue` 只记新增部分。
 */
const btwThreads = new WeakMap<object, BtwThread>();

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

  let thread = isContinue ? btwThreads.get(agent as object) : undefined;
  const isFallback = isContinue && !thread;
  if (!thread) {
    thread = createBtwThread(agent);
    btwThreads.set(agent as object, thread);
  }
  const subagent = thread.subagent;

  upsertBtwNotice(services, `> ${question}\n\n正在思考…`, 'running');

  const startedAt = new Date().toISOString();
  try {
    const reply = await subagent.query(question);
    upsertBtwNotice(services, formatBtwNotice(question, reply, isFallback), 'success');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    upsertBtwNotice(services, `> ${question}\n\nbtw 出错：${message}`, 'error');
  } finally {
    // btw 的请求不属于任何 turn，也不进主流程的 usageHistory，只有这里能记账。
    const requests = subagent.usageHistory ?? [];
    if (requests.length > thread.recordedRequests) {
      recordHelperSubagentUsage(agent, services, requests.slice(thread.recordedRequests), {
        taskId: 'btw',
        subagentType: 'btw',
        description: question,
        model: agent.config.model,
        effort: 'none',
        status: 'completed',
        startedAt,
        finishedAt: new Date().toISOString(),
      });
    }
    thread.recordedRequests = requests.length;
  }
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
