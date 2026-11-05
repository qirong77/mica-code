/**
 * 「让用户做一个选择，然后继续」的能力面。
 *
 * 插件里的工具经常跑到一个模型判断不了的岔路口：两种方案都成立、要不要动线上、这条
 * 数据挑哪一条。今天只能把问题写进工具结果里让模型自己猜，或者把问题当正文说出来等
 * 用户再发一条——前者等于替用户决定，后者要用户重新组织一句话。
 *
 * `ctx.ask.request()` 把这一步变成一次真正的问答：宿主把问题画在客户端上，用户点一下，
 * 工具拿到答案继续跑**同一次迭代**。它不改历史、不发起新的模型请求，所以「选完之后直接
 * 进入下一轮」不需要任何额外的投递机制。
 *
 * 谁来问、问什么、答案怎么用（拼一段提示词、跑一段脚本、只是记下来）都由插件决定；
 * 宿主只负责传输与等待，内核里不出现任何具体插件的提问策略。
 *
 * 只有能把问题画给人、并且能收到点选的宿主才提供这一面（桌面端的 `mica app-server`）。
 * TUI 与 `mica exec` 不提供：那边没有可点的地方，装载成功却没人回答比整插件跳过更糟。
 */

/** 一道选择里的一个选项。 */
export type PluginAskOption = {
  /** 在本题内唯一。答案回传的就是它。 */
  id: string;
  label: string;
  /** 一行补充说明，画在标签下面。 */
  description?: string;
  /**
   * 选中它之后交给模型的那段话（进工具结果正文）。
   *
   * 用它把「选择」变成一段明确的指令，就不必指望模型从选项标题里自己领会意图。
   */
  prompt?: string;
  /**
   * 选中它之后立刻执行的一段 shell 命令（cwd 是这条会话的工作目录）。
   *
   * 输出并进工具结果，所以模型看得到执行结果。只在这条命令确实该跑的时候给——它和
   * `run_shell` 一样是真执行，不是提示。
   */
  command?: string;
};

export type PluginAskQuestion = {
  /** 一句话问题，画成标题。 */
  title: string;
  /** 补充说明（Markdown 不解析，纯文本）。 */
  detail?: string;
  options: PluginAskOption[];
  /** 允许多选。多选时用户点「确定」才提交。 */
  multiple?: boolean;
  /**
   * 除了给定选项，还允许用户自己写一句。默认开。
   *
   * 关掉它（`allowCustom: false` 或 `ui.input: false`）只留给「答案就在这几个选项里」的
   * 确认弹窗：输入框在的时候用户可以随时改口说别的，那多数场景正是想要的。
   */
  allowCustom?: boolean;
  /**
   * 画在哪里。默认 `dock`（输入框上方一条）；`modal` 是居中弹窗。
   *
   * 需要打断当前注意力的事情（例如「上下文快满了，要不要现在压缩」）用 modal；
   * 与这一轮内容连着看更自然的选择用 dock。
   */
  presentation?: PluginAskPresentation;
  /**
   * 逐个元素开关，缺省按数据推导。
   *
   * 用途是让同一套组件适配很不一样的场景：自动压缩的确认弹窗只要标题 + 两个按钮，
   * 不要自由输入框；收集一段文字的场景则反过来，只留输入框。
   */
  ui?: PluginAskUi;
  /**
   * 等多久算放弃（毫秒）。默认 15 分钟，上限 1 小时。
   *
   * 超时不是错误：工具会拿到 `cancelled` + `reason: 'timeout'`，自己决定退化成什么
   * （通常是「没等到回答，先按推荐项继续」或者直接停下报告）。
   */
  timeoutMs?: number;
  /**
   * 会话列表里那句提示（「等你选方案」）。缺省用 `title`。
   *
   * 侧栏一行放不下太长的句子，所以短的 summary + 长的 title 是有意义的搭配。
   */
  summary?: string;
};

export type PluginAskPresentation = 'dock' | 'modal';

/**
 * 一道题里每个元素要不要画。不传就按数据推导：
 *
 * - `icon` / `hint` / `dismiss` 默认画；
 * - `meta` 只在有两个以上选项时画（「3 个方案 · 单选」）；
 * - `detail` 看有没有 `detail`；
 * - `input` 默认画（`allowCustom: false` 才关）；
 * - `confirm` 看是否需要二次确认（多选）；
 * - `options` 只要有选项就画。
 */
export type PluginAskUi = {
  icon?: boolean;
  meta?: boolean;
  detail?: boolean;
  options?: boolean;
  input?: boolean;
  confirm?: boolean;
  hint?: boolean;
  dismiss?: boolean;
};

/** 结束原因。`answered` 是唯一「用户真的选了」的情况。 */
export type PluginAskReason = 'answered' | 'cancelled' | 'timeout' | 'aborted';

export type PluginAskAnswer = {
  /** 用户选中的选项 id（单选时最多一个）。 */
  optionIds: string[];
  /** `allowCustom` 时用户自己写的那句话。 */
  custom?: string;
  cancelled: boolean;
  reason: PluginAskReason;
};

export type PluginAskRequestOptions = {
  /**
   * 中止这次等待。工具拿到的 `callbacks.signal` 直接传进来即可。
   *
   * 中止后宿主立刻撤掉那个问题：用户不该对着一个已经没有人在等的问题点按钮。
   */
  signal?: AbortSignal;
};

/**
 * 被动提问的句柄。发出去了，插件继续干自己的事。
 *
 * 典型用法是「后台发现了一件事，问用户要不要处理」：不能因此把整轮挂住，也不需要
 * 用户立刻回答——不点就什么都不发生。
 */
export type PluginAskHandle = {
  id: string;
  /** 用户答了 / 超时 / 被撤掉时 resolve。 */
  answered: Promise<PluginAskAnswer>;
  /** 主动撤掉（例如触发它的那个场景已经过去了）。 */
  dismiss(): void;
};

export type PluginAskApi = {
  /**
   * 阻塞式提问：等用户点完再继续。
   *
   * 只在**一轮对话里**（工具执行期间）可靠：宿主是逐行读请求的，答案要等当前这一行处理完
   * 才轮得到。在面板动作、维护窗口这类「宿主正在 await 你的回调」的位置上调用它，答案会
   * 排在回调之后，只能等到超时——那种场景用 `post()`。
   */
  request(question: PluginAskQuestion, options?: PluginAskRequestOptions): Promise<PluginAskAnswer>;
  /**
   * 非阻塞提问：把卡片发给用户就返回，不占着调用方。
   *
   * 用户不回答也不影响任何东西——卡片留到用户处理或超时为止。
   */
  post(question: PluginAskQuestion, options?: PluginAskRequestOptions): PluginAskHandle;
};

/** 一次提问最多几个选项：客户端是一列按钮，多了就没人看。 */
export const MAX_PLUGIN_ASK_OPTIONS = 8;
export const DEFAULT_PLUGIN_ASK_TIMEOUT_MS = 15 * 60 * 1000;
export const MAX_PLUGIN_ASK_TIMEOUT_MS = 60 * 60 * 1000;
/** 会话列表里那行提示的上限（与会话文件的 `awaitingInput` 同一个尺度）。 */
export const MAX_PLUGIN_ASK_SUMMARY = 120;

/**
 * 校验并规整一次提问。
 *
 * 形状不对要**抛错**而不是「悄悄修好」：这是插件自己写错的东西，让工具收到一条可读的
 * 错误比让用户看到一个缺胳膊少腿的界面强。可选的超时与文本长度按上限收，不算错误。
 */
export function normalizePluginAskQuestion(input: PluginAskQuestion): PluginAskQuestion {
  const title = text(input?.title, 200);
  if (!title) throw new Error('提问缺少 title');
  const detail = text(input?.detail, 2000) || undefined;

  const rawOptions = Array.isArray(input?.options) ? input.options : [];
  if (rawOptions.length === 0) throw new Error('提问至少要有一个选项');
  if (rawOptions.length > MAX_PLUGIN_ASK_OPTIONS) {
    throw new Error(`提问最多 ${MAX_PLUGIN_ASK_OPTIONS} 个选项，收到 ${rawOptions.length} 个`);
  }

  const seen = new Set<string>();
  const options: PluginAskOption[] = rawOptions.map((option, index) => {
    const id = text(option?.id, 64);
    if (!id) throw new Error(`第 ${index + 1} 个选项缺少 id`);
    if (seen.has(id)) throw new Error(`选项 id 重复：${id}`);
    seen.add(id);
    const label = text(option?.label, 120);
    if (!label) throw new Error(`选项 ${id} 缺少 label`);
    const description = text(option?.description, 400) || undefined;
    const prompt = text(option?.prompt, 4000) || undefined;
    const command = text(option?.command, 4000) || undefined;
    return {
      id,
      label,
      ...(description ? { description } : {}),
      ...(prompt ? { prompt } : {}),
      ...(command ? { command } : {}),
    };
  });

  // `null` / `''` / `0` 都是「没给」：`Number(null)` 是 0，按 0 收下来就成了 1 秒超时，
  // 卡片刚画出来就消失。只有正数才算指定了时长。
  const asked = Number(input?.timeoutMs);
  const timeoutMs =
    Number.isFinite(asked) && asked > 0
      ? Math.min(Math.max(asked, 1000), MAX_PLUGIN_ASK_TIMEOUT_MS)
      : DEFAULT_PLUGIN_ASK_TIMEOUT_MS;

  return {
    title,
    ...(detail ? { detail } : {}),
    options,
    ...(input?.multiple === true ? { multiple: true } : {}),
    ...(typeof input?.allowCustom === 'boolean' ? { allowCustom: input.allowCustom } : {}),
    ...(input?.presentation === 'modal' ? { presentation: 'modal' as const } : {}),
    ...(input?.ui ? { ui: { ...input.ui } } : {}),
    timeoutMs,
    ...(text(input?.summary, MAX_PLUGIN_ASK_SUMMARY) ? { summary: text(input.summary, MAX_PLUGIN_ASK_SUMMARY) } : {}),
  };
}

/**
 * 把「要不要画某个元素」定成最终结论。
 *
 * 放在这一侧而不是界面里：界面只有一份快照，缺字段时只能猜；插件知道这道题是干什么
 * 的，猜错了也只是它自己的界面难看。默认值依赖数据，所以要能同时看到选项数、`multiple`、
 * `allowCustom`。
 */
export function resolvePluginAskDisplay(question: PluginAskQuestion): Required<PluginAskUi> {
  const ui = question.ui ?? {};
  const pick = (value: boolean | undefined, fallback: boolean): boolean =>
    typeof value === 'boolean' ? value : fallback;
  const allowCustom = question.allowCustom !== false;
  return {
    icon: pick(ui.icon, true),
    meta: pick(ui.meta, question.options.length > 1),
    detail: pick(ui.detail, true) && Boolean(question.detail),
    options: pick(ui.options, question.options.length > 0),
    input: pick(ui.input, allowCustom),
    // 单选时点一下就交；多选要攒几个再提交，才需要「确定」。
    // 自由输入不需要额外的确认按钮：打了字之后界面自己会出现一个。
    confirm: pick(ui.confirm, Boolean(question.multiple)),
    hint: pick(ui.hint, true),
    dismiss: pick(ui.dismiss, true),
  };
}
/** 会话列表 / 客户端标题里用的那句提示：短的 summary 优先，其次 title。 */
export function pluginAskSummary(question: PluginAskQuestion): string {
  const short = text(question.summary, MAX_PLUGIN_ASK_SUMMARY);
  if (short) return short;
  return text(question.title, MAX_PLUGIN_ASK_SUMMARY);
}

function text(value: unknown, limit: number): string {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  if (!trimmed) return '';
  return trimmed.length > limit ? trimmed.slice(0, limit) : trimmed;
}
