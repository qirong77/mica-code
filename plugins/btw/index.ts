import type { PluginContext, PluginNoticeOptions, PluginSubagentThread } from '@packages/mica-plugin/index.js';
import { micaAgent } from '@packages/mica-agent/index.js';
import { buildBtwSystemPrompt, messagesToTranscript } from '@packages/mica-builtin-commands/shared/btwThread.js';
import { btwHelpText, formatBtwNotice, formatBtwProgress, formatBtwStopped, parseBtwArgs } from './message.js';

const BTW_COMMAND = '/btw';
/** 进度面板的刷新间隔：终端里每秒一次已经足够「它还活着」，再快只是白重渲染。 */
const PROGRESS_TICK_MS = 1_000;
/** 流式事件（工具切换、正文 delta）也要尽快反映，但不必每个 delta 都重渲染一次。 */
const PROGRESS_MIN_INTERVAL_MS = 250;
/** 停止时展示的部分回答上限：它是「已经流出来的那半段」，不是完整答案。 */
const MAX_PARTIAL_ANSWER_CHARS = 20_000;

/**
 * `/btw`（By The Way）：在主流程旁边开一条隔离子代理，问一句、答一句，不打断主流程、
 * 不写回主对话上下文。
 *
 * 它只做四件事，其余都在宿主：
 * - 从 `ctx.session` 取主流程的对话记录与角色，用共享的提示词构造器拼出旁问的
 *   system prompt（与桌面端抽屉同一份，见 `mica-builtin-commands/shared/btwThread.ts`）；
 * - 用 `ctx.subagents.thread` 开一条可复用的子代理线程，`-continue` 复用它（它的消息
 *   数组就是这条旁问的上下文，所以追问能看到上一轮读过什么）；
 * - 把子代理的流式回调折成输入框上方那一条进度（正在调用哪个工具、已经出了多少字、
 *   跑了多久），长回答在终端里也不再是「一片安静」；
 * - `/btw -stop` 中断正在回答的那一问，已经流出的正文仍然展示出来。
 *
 * 一次只回答一个问题：同一个子代理的消息数组不是并发安全的，而且两条回答共用一条
 * `/btw` notice，并发只会互相覆盖到看不懂。
 *
 * 记账由宿主在做（每次提问只记新增的请求，`origin: 'plugin'`），这里不碰用量。
 */
export default function setupBtw(ctx: PluginContext): void {
  if (!ctx.commands) throw new Error('btw requires ctx.commands');
  if (!ctx.session) throw new Error('btw requires ctx.session');
  if (!ctx.subagents) throw new Error('btw requires ctx.subagents');
  if (!ctx.ui) throw new Error('btw requires ctx.ui');
  if (!ctx.events) throw new Error('btw requires ctx.events');

  // 一条旁问线程按会话保存：同一个会话里的 `-continue` 要接着同一份上下文。
  const states = new Map<unknown, BtwState>();
  const lifecycle = ctx.events.on('event', (event) => {
    if (event.type !== 'session:cleared' && event.type !== 'session:invalidated' && event.type !== 'session:disposed') return;
    const owner = event.owner ?? ctx.session?.captureOwner?.();
    for (const [key, state] of states) {
      if (state.owner !== owner) continue;
      disposeState(state);
      states.delete(key);
    }
  });
  ctx.onDispose(() => lifecycle.dispose());

  const registration = ctx.commands.register({
    name: 'btw',
    description: 'By The Way：用一个隔离子代理回答，不打扰主流程（/btw 问题，/btw -continue 追问，/btw -stop 停止）',
    scope: 'local-only',
    // 主流程正在运行时也能问：旁问的意义就是「不插进主流程的队列」。
    allowDuringTurn: true,
    pluginId: ctx.pluginId,
    completionItems: [
      { arg: '-continue', label: '-continue', description: '在同一个 btw 线程里追问' },
      { arg: '-stop', label: '-stop', description: '停止正在回答的旁问' },
    ],
    async handler(_commandCtx, args) {
      await runBtw(ctx, states, args ?? '');
      return { ok: true };
    },
  });
  ctx.onDispose(() => registration.dispose());
  ctx.onDispose(() => {
    for (const state of states.values()) {
      disposeState(state);
    }
    states.clear();
  });

  ctx.logger.info('btw:ready');
}

/** 一条会话的旁问状态：可复用线程 + 当前那一问的运行态。 */
type BtwState = {
  sessionId: string;
  owner: unknown;
  disposed: boolean;
  stopProgress?: () => void;
  thread: PluginSubagentThread | null;
  controller: AbortController | null;
  running: boolean;
  /** 正在回答（或刚回答完）的问题，用于 `/btw -stop` 的进度面板。 */
  question: string;
  startedAt: number;
  tool: string;
  /** 已经流出的正文：停止时它是这一问唯一的记录。 */
  answer: string;
  answerChars: number;
};

function ensureState(states: Map<unknown, BtwState>, sessionId: string, owner: unknown): BtwState {
  const key = owner ?? sessionId;
  let state = states.get(key);
  if (state && state.sessionId !== sessionId) {
    disposeState(state);
    state = undefined;
  }
  if (!state) {
    state = {
      sessionId,
      owner,
      disposed: false,
      thread: null,
      controller: null,
      running: false,
      question: '',
      startedAt: 0,
      tool: '',
      answer: '',
      answerChars: 0,
    };
    states.set(key, state);
  }
  return state;
}

async function runBtw(ctx: PluginContext, states: Map<unknown, BtwState>, rawArgs: string): Promise<void> {
  const parsed = parseBtwArgs(rawArgs);
  if (parsed.kind === 'help') {
    ctx.ui?.notice(btwHelpText(), { command: BTW_COMMAND, status: 'info' });
    return;
  }

  const session = ctx.session?.describe();
  if (!session) {
    ctx.ui?.notice('btw 需要先有一条会话', { command: BTW_COMMAND, status: 'error' });
    return;
  }
  const state = ensureState(states, session.id, ctx.session?.captureOwner?.());

  if (parsed.kind === 'stop') {
    if (!state.running || !state.controller) {
      ctx.ui?.notice('当前没有正在回答的 btw', { command: BTW_COMMAND, status: 'info' });
      return;
    }
    state.controller.abort();
    state.stopProgress?.();
    // 收尾（warning notice）在 ask 的 catch 里做：那里才知道已经流出了多少正文。
    ctx.ui?.notice(`> ${state.question}\n\n正在停止…`, {
      command: BTW_COMMAND,
      status: 'running',
      surface: 'command_panel',
    });
    return;
  }

  if (state.running) {
    ctx.ui?.notice(`> ${state.question}\n\n上一个 btw 还在回答中：用 /btw -stop 停止，或等它答完再追问`, {
      command: BTW_COMMAND,
      status: 'warning',
    });
    return;
  }

  const { question, isContinue } = parsed;
  const isFallback = isContinue && !state.thread;
  if (!isContinue) {
    // 不带 -continue 就是新话题：旧线程的上下文不再需要，且必须显式丢掉——
    // 每问一句都换一个新子代理，不 dispose 会让它们连同消息数组一直挂在会话上。
    disposeThread(state);
  }
  if (!state.thread) {
    const created = createThread(ctx, question, session.role);
    if (!created) return;
    state.thread = created;
  }

  await ask(ctx, state, question, isFallback);
}

/** 问一次当前线程，把过程写进同一条 `/btw` 进度面板。 */
async function ask(ctx: PluginContext, state: BtwState, question: string, isFallback: boolean): Promise<void> {
  const thread = state.thread;
  if (!thread) return;
  const beforeRequests = thread.usage().requests;
  state.running = true;
  state.controller = new AbortController();
  state.question = question;
  state.startedAt = Date.now();
  state.tool = '';
  state.answer = '';
  state.answerChars = 0;

  const controller = state.controller;
  const owner = state.owner;
  const active = () => !state.disposed && state.controller === controller && !controller.signal.aborted;
  const notice = (content: string, options: PluginNoticeOptions): void => {
    // 捕获的 owner 允许结果回到已切走的会话；同一 controller 已 resume 到其他会话时
    // describe(owner) 的 id 会改变，此时旧结果应丢弃。旧宿主仍以当前会话校验防止串写。
    if (state.disposed || ctx.session?.describe(owner)?.id !== state.sessionId) return;
    ctx.ui?.notice(content, owner === undefined ? options : { ...options, owner });
  };
  let lastEmit = 0;
  const emitProgress = (force = false): void => {
    if (!active()) return;
    const now = Date.now();
    // 定时器每次都要刷新（耗时在走字）；delta 与工具切换只是在两 tick 之间补一次。
    if (!force && now - lastEmit < PROGRESS_MIN_INTERVAL_MS) return;
    lastEmit = now;
    notice(
      formatBtwProgress({
        question,
        tool: state.tool,
        answerChars: state.answerChars,
        elapsedMs: now - state.startedAt,
      }),
      { command: BTW_COMMAND, status: 'running', surface: 'command_panel' },
    );
  };
  emitProgress();
  // 模型长时间不出字时也要让耗时走字：只靠 delta 触发的话，面板会停在 0.0s 一动不动。
  const ticker = setInterval(() => emitProgress(true), PROGRESS_TICK_MS);
  state.stopProgress = () => clearInterval(ticker);
  (ticker as unknown as { unref?: () => void }).unref?.();

  try {
    const answer = await thread.ask(question, {
      description: question,
      signal: controller.signal,
      onText: (text) => {
        if (!text || !active()) return;
        state.answerChars += text.length;
        const remaining = MAX_PARTIAL_ANSWER_CHARS - state.answer.length;
        if (remaining > 0) state.answer += text.slice(0, remaining);
        emitProgress();
      },
      onToolCall: (name) => {
        if (!active()) return;
        state.tool = name;
        // 工具切换是低频事件，且「正在调用什么」是最该及时看到的一行：绕过节流。
        emitProgress(true);
      },
      onToolResult: (name) => {
        if (!active()) return;
        if (state.tool === name) state.tool = '';
        emitProgress(true);
      },
    });
    controller.signal.throwIfAborted();
    const elapsedMs = Date.now() - state.startedAt;
    const requests = thread.usage().requests - beforeRequests;
    notice(formatBtwNotice(question, answer, { isFallback, elapsedMs, requests }), {
      command: BTW_COMMAND,
      status: 'success',
    });
  } catch (error) {
    if (controller.signal.aborted) {
      // 停止不是失败：已经流出来的那半段就是这一问的答案，不能丢。
      const partial = state.answerChars > state.answer.length
        ? `${state.answer}\n…[截断：仅保留前 ${state.answer.length} 字符，共输出 ${state.answerChars} 字符]`
        : state.answer;
      notice(formatBtwStopped(question, partial), {
        command: BTW_COMMAND,
        status: 'warning',
      });
    } else {
      const message = error instanceof Error ? error.message : String(error);
      notice(`> ${question}\n\nbtw 出错：${message}`, {
        command: BTW_COMMAND,
        status: 'error',
      });
    }
  } finally {
    clearInterval(ticker);
    state.stopProgress = undefined;
    state.running = false;
    state.controller = null;
    state.tool = '';
  }
}

function disposeThread(state: BtwState): void {
  state.thread?.dispose();
  state.thread = null;
}

function disposeState(state: BtwState): void {
  state.disposed = true;
  state.stopProgress?.();
  state.controller?.abort();
  disposeThread(state);
}

/** 开一条新线程：背景就是主流程当前的文字对话记录（只读，不进主上下文）。 */
function createThread(ctx: PluginContext, question: string, roleName: string | undefined): PluginSubagentThread | null {
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
    ctx.ui?.notice(`btw 暂时不可用：${message}`, { command: BTW_COMMAND, status: 'error' });
    return null;
  }
}
