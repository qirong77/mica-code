import type { PluginContext, PluginSubagentThread } from '@packages/mica-plugin/index.js';
import { micaAgent } from '@packages/mica-agent/index.js';
import { buildBtwSystemPrompt, messagesToTranscript } from '@packages/mica-builtin-commands/shared/btwThread.js';
import { formatBtwNotice, parseBtwArgs } from './message.js';

/**
 * `/btw`（By The Way）：在主流程旁边开一条隔离子代理，问一句、答一句，不打断主流程、
 * 不写回主对话上下文。
 *
 * 它只做三件事，其余都在宿主：
 * - 从 `ctx.session` 取主流程的对话记录与角色，用共享的提示词构造器拼出旁问的
 *   system prompt（与桌面端抽屉同一份，见 `mica-builtin-commands/shared/btwThread.ts`）；
 * - 用 `ctx.subagents.thread` 开一条可复用的子代理线程，`-continue` 复用它（它的消息
 *   数组就是这条旁问的上下文，所以追问能看到上一轮读过什么）；
 * - 用 `ctx.ui.notice` 回报进度与答案：运行中固定在输入框上方，完成后落进对话。
 *
 * 记账由宿主在做（每次提问只记新增的请求，`origin: 'plugin'`），这里不碰用量。
 */
export default function setupBtw(ctx: PluginContext): void {
  if (!ctx.commands) throw new Error('btw requires ctx.commands');
  if (!ctx.session) throw new Error('btw requires ctx.session');
  if (!ctx.subagents) throw new Error('btw requires ctx.subagents');
  if (!ctx.ui) throw new Error('btw requires ctx.ui');

  // 一条旁问线程按会话保存：同一个会话里的 `-continue` 要接着同一份上下文。
  const threads = new Map<string, PluginSubagentThread>();

  const registration = ctx.commands.register({
    name: 'btw',
    description: 'By The Way：用一个隔离子代理回答，不打扰主流程（用法：/btw 问题，/btw -continue 追问）',
    scope: 'local-only',
    // 主流程正在运行时也能问：旁问的意义就是「不插进主流程的队列」。
    allowDuringTurn: true,
    pluginId: ctx.pluginId,
    async handler(_commandCtx, args) {
      await runBtw(ctx, threads, args ?? '');
      return { ok: true };
    },
  });
  ctx.onDispose(() => registration.dispose());
  ctx.onDispose(() => {
    for (const thread of threads.values()) thread.dispose();
    threads.clear();
  });

  ctx.logger.info('btw:ready');
}

async function runBtw(
  ctx: PluginContext,
  threads: Map<string, PluginSubagentThread>,
  rawArgs: string,
): Promise<void> {
  const parsed = parseBtwArgs(rawArgs);
  if (!parsed) {
    ctx.ui?.notice('用法：/btw <问题>，或在一条 btw 完成后用 /btw -continue <追问> 继续', {
      command: '/btw',
      status: 'info',
    });
    return;
  }

  const session = ctx.session?.describe();
  if (!session) {
    ctx.ui?.notice('btw 需要先有一条会话', { command: '/btw', status: 'error' });
    return;
  }

  const { question, isContinue } = parsed;
  let thread = isContinue ? threads.get(session.id) : undefined;
  const isFallback = isContinue && !thread;
  if (!thread) {
    const created = createThread(ctx, question, session.role);
    if (!created) return;
    thread = created;
    threads.set(session.id, created);
  }

  ctx.ui?.notice(`> ${question}\n\n正在思考…`, { command: '/btw', status: 'running', surface: 'command_panel' });
  try {
    const reply = await thread.ask(question, { description: question });
    ctx.ui?.notice(formatBtwNotice(question, reply, isFallback), { command: '/btw', status: 'success' });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    ctx.ui?.notice(`> ${question}\n\nbtw 出错：${message}`, { command: '/btw', status: 'error' });
  }
}

/** 开一条新线程：背景就是主流程当前的文字对话记录（只读，不进主上下文）。 */
function createThread(
  ctx: PluginContext,
  question: string,
  roleName: string | undefined,
): PluginSubagentThread | null {
  const transcript = messagesToTranscript(ctx.session?.messages() ?? []);
  const role = roleName?.trim();
  try {
    return ctx.subagents!.thread({
      type: 'btw',
      description: question,
      systemPrompt: buildBtwSystemPrompt(
        transcript,
        // 读不到角色正文（文件在会话中途被删）时只带名字：少一段背景总好过整条旁问建不起来。
        role ? { role: { name: role, prompt: micaAgent.roles.get(role)?.prompt ?? '' } } : {},
      ),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    ctx.ui?.notice(`btw 暂时不可用：${message}`, { command: '/btw', status: 'error' });
    return null;
  }
}
