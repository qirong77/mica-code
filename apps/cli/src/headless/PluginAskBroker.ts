import type {
  MicaAskAnswerParams,
  MicaAskPending,
  MicaAskSnapshot,
} from '@packages/mica-runtime/index.js';
import {
  DEFAULT_PLUGIN_ASK_TIMEOUT_MS,
  normalizePluginAskQuestion,
  pluginAskSummary,
} from '@packages/mica-plugin/index.js';
import type {
  PluginAskAnswer,
  PluginAskApi,
  PluginAskQuestion,
  PluginAskRequestOptions,
} from '@packages/mica-plugin/index.js';

/**
 * 一次待回答的问题。宿主只保管「谁在等、问了什么、怎么算结束」，怎么用答案归插件。
 */
export type PluginAskHost = {
  /**
   * 交给某个插件的 `ctx.ask`（按 pluginId 绑定）。
   *
   * 绑定而不是共用一个对象，是为了让推给界面的问题带着「哪个插件问的」——同一次会话里
   * 可能有好几个插件都会问，界面上说清楚来源比猜强。
   */
  forPlugin(pluginId: string): PluginAskApi;
  /** 当前待回答的问题；页面中途附着上来时用它补上已经推过的那一张卡片。 */
  pending(): MicaAskPending | null;
  /** 页面点了选项。`askId` 对不上（超时 / 已被中止）返回失败，页面据此收掉卡片。 */
  answer(params: MicaAskAnswerParams): { ok: true } | { ok: false; error: string };
  /** 宿主收尾：还在等的问题一律按「宿主停了」结束，别把一个永远不会有人回答的卡片留在页面上。 */
  dispose(): void;
};

export type PluginAskBrokerOptions = {
  /** 把当前问题推给客户端（`mica/ask/updated`）。 */
  notify(snapshot: MicaAskSnapshot): void;
  /**
   * 在会话文件上标出「这条在等用户做一个选择」，让侧栏能提醒。
   *
   * 传 `null` 清除。落盘与信号广播都由宿主实现：插件只说出「在等什么」。
   */
  markWaiting(summary: string | null): void;
  /** 现在这条会话的 id，随快照一起发出去。 */
  threadId(): string | null;
};

type Pending = {
  ask: MicaAskPending;
  question: PluginAskQuestion;
  resolve(answer: PluginAskAnswer): void;
  timer: NodeJS.Timeout | null;
  /** 已经结束（回答 / 超时 / 中止）时不再接受新的回答。 */
  settled: boolean;
};

/**
 * 「插件问、用户答」的中转站。
 *
 * 为什么需要它：插件的工具是同步跑在一次迭代里的，它唯一的等待手段就是 await 一个
 * promise；而答案来自另一个方向（客户端发来的 `mica/ask/answer` 请求）。宿主这一层
 * 把两头接起来，插件侧看到的只是 `ctx.ask.request()` 返回一个 promise。
 *
 * 宿主进程是逐行读 stdin 的，但一轮 turn 是异步跑的（`start()` 立刻返回），所以工具
 * 挂着等回答时这台宿主仍然能收下 `mica/ask/answer`、`turn/interrupt` 这些请求。
 *
 * 同一时刻只允许一个待回答的问题：客户端在输入框上方只有一块位置，两个问题同时挂在
 * 那里时用户没法判断自己在回答哪一个。第二个请求会直接报错给工具（模型看得到）。
 */
export function createPluginAskBroker(options: PluginAskBrokerOptions): PluginAskHost {
  let current: Pending | null = null;
  let disposed = false;

  const publish = () => {
    options.notify({ threadId: options.threadId(), ask: current?.ask ?? null });
  };

  const finish = (answer: PluginAskAnswer): void => {
    const pending = current;
    if (!pending || pending.settled) return;
    pending.settled = true;
    if (pending.timer) clearTimeout(pending.timer);
    pending.timer = null;
    current = null;
    // 先撤掉界面再叫醒工具：反过来的话，工具（可能是插件自己跑一段脚本）跑完之前，
    // 用户会对着一个已经没人等的问题继续点。
    options.markWaiting(null);
    publish();
    pending.resolve(answer);
  };

  function request(
    pluginId: string,
    question: PluginAskQuestion,
    requestOptions: PluginAskRequestOptions = {},
  ): Promise<PluginAskAnswer> {
    if (disposed) {
      return Promise.resolve({ optionIds: [], cancelled: true, reason: 'aborted' });
    }
    const normalized = normalizePluginAskQuestion(question);
    if (current) {
      throw new Error('已经有一个问题在等用户回答，同一个会话一次只能问一个');
    }
    if (requestOptions.signal?.aborted) {
      return Promise.resolve({ optionIds: [], cancelled: true, reason: 'aborted' });
    }

    const ask: MicaAskPending = {
      id: `ask_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
      pluginId,
      title: normalized.title,
      ...(normalized.detail ? { detail: normalized.detail } : {}),
      options: normalized.options.map((option) => ({
        id: option.id,
        label: option.label,
        ...(option.description ? { description: option.description } : {}),
      })),
      ...(normalized.multiple ? { multiple: true } : {}),
      ...(normalized.allowCustom ? { allowCustom: true } : {}),
      summary: pluginAskSummary(normalized),
      askedAt: new Date().toISOString(),
    };

    return new Promise<PluginAskAnswer>((resolve) => {
      const pending: Pending = { ask, question: normalized, resolve, timer: null, settled: false };
      current = pending;
      // 侧栏信号先落盘再推界面：用户在别的会话里看到「等你选」点进来时，卡片应该已经在了。
      options.markWaiting(ask.summary);
      publish();

      const timeoutMs = normalized.timeoutMs ?? DEFAULT_PLUGIN_ASK_TIMEOUT_MS;
      pending.timer = setTimeout(() => {
        finish({ optionIds: [], cancelled: true, reason: 'timeout' });
      }, timeoutMs);
      // 纯等待不该把宿主进程按在事件循环上退出不了：它自己会随着会话收尾被清掉。
      pending.timer.unref?.();

      requestOptions.signal?.addEventListener(
        'abort',
        () => finish({ optionIds: [], cancelled: true, reason: 'aborted' }),
        { once: true },
      );
    });
  }

  return {
    forPlugin(pluginId: string): PluginAskApi {
      return {
        request: (question, requestOptions) => request(pluginId, question, requestOptions),
      };
    },
    pending: () => current?.ask ?? null,
    answer(params) {
      const pending = current;
      if (!pending || pending.settled) {
        return { ok: false, error: '这个问题已经不需要回答了' };
      }
      if (typeof params.askId === 'string' && params.askId && params.askId !== pending.ask.id) {
        return { ok: false, error: '回答的不是当前这个问题' };
      }
      const known = new Set(pending.question.options.map((option) => option.id));
      // 单选取最后一个：客户端已经保证点一个就提交，这里只是把「页面出错」挡在插件之外。
      const picked = (Array.isArray(params.optionIds) ? params.optionIds : []).filter((id) =>
        known.has(id),
      );
      const optionIds = pending.ask.multiple ? [...new Set(picked)] : picked.slice(-1);
      const custom = typeof params.custom === 'string' ? params.custom.trim() : '';
      if (optionIds.length === 0 && !custom) {
        return { ok: false, error: '没有选中任何选项' };
      }
      finish({
        optionIds,
        ...(custom ? { custom } : {}),
        cancelled: false,
        reason: 'answered',
      });
      return { ok: true };
    },
    dispose() {
      disposed = true;
      finish({ optionIds: [], cancelled: true, reason: 'aborted' });
    },
  };
}
