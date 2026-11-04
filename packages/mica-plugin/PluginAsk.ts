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
  /** 除了给定选项，还允许用户自己写一句。 */
  allowCustom?: boolean;
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

export type PluginAskApi = {
  request(question: PluginAskQuestion, options?: PluginAskRequestOptions): Promise<PluginAskAnswer>;
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

  const asked = Number(input?.timeoutMs);
  const timeoutMs = Number.isFinite(asked)
    ? Math.min(Math.max(asked, 1000), MAX_PLUGIN_ASK_TIMEOUT_MS)
    : DEFAULT_PLUGIN_ASK_TIMEOUT_MS;

  return {
    title,
    ...(detail ? { detail } : {}),
    options,
    ...(input?.multiple === true ? { multiple: true } : {}),
    ...(input?.allowCustom === true ? { allowCustom: true } : {}),
    timeoutMs,
    ...(text(input?.summary, MAX_PLUGIN_ASK_SUMMARY) ? { summary: text(input.summary, MAX_PLUGIN_ASK_SUMMARY) } : {}),
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
