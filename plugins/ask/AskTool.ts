import { execFile } from 'node:child_process';
import type {
  PluginAskAnswer,
  PluginAskApi,
  PluginAskOption,
  PluginAskQuestion,
} from '@packages/mica-plugin/index.js';
import { MicaTool, type ToolExecuteCallbacks, type ToolInput } from '@packages/mica-tools/index.js';

export const ASK_TOOL_NAME = 'ask_user';

/** 命令输出进工具结果的上限：让模型看到够判断的上下文，又不至于吞掉整段上下文。 */
const MAX_COMMAND_OUTPUT = 4000;
const COMMAND_TIMEOUT_MS = 120_000;

/**
 * `ask_user`：把「这一步有几种做法，你来定」变成一次真正的点选。
 *
 * 工具本身只做三件事——把输入翻成一次提问、等答案、把答案拼成模型能直接接着干的一段话。
 * 等待期间的界面、超时、中止都在宿主的 `ctx.ask` 里，所以这个工具不自己画东西、
 * 也不碰会话文件。
 *
 * 选项上的 `prompt` / `command` 是「选完立刻做什么」：`prompt` 变成工具结果里的指令段落，
 * `command` 当场执行并把输出并进结果。两者都不给时，结果就是一句「用户选了 A」。
 */
export class AskUserTool extends MicaTool {
  constructor(private readonly ask: PluginAskApi) {
    super(
      ASK_TOOL_NAME,
      [
        'Ask the user to pick between concrete options, and continue in the same turn once they answer.',
        'Use it when several approaches are genuinely reasonable and the choice is theirs: product/taste decisions, which of two designs to build, whether to touch live data, which row of data is the right one.',
        'Give 2-4 options (max 8). Each option needs an `id` and a short `label`; add `description` for the one-line trade-off.',
        'The card also shows a free-text field by default, so the user can type their own answer instead of picking; pass `allowCustom: false` when the answer must be one of the listed options.',
        'Attach `prompt` to an option to tell yourself what to do when it is picked (it becomes part of the tool result). Attach `command` only when a real shell command should run on pick — and make sure the label or description says what will run, since the user clicks before it executes.',
        'The question should be one decision, phrased as a question. Do not use it for "should I continue?" or to narrate progress.',
        'This tool blocks until the user answers. If it returns `cancelled`, do not ask the same thing again: continue with the most conservative option and say what you chose.',
      ].join(' '),
      {
        type: 'object',
        properties: {
          title: {
            type: 'string',
            description: 'The one-line question, for example "钱包改版先做哪个入口？"',
          },
          detail: {
            type: 'string',
            description: 'Optional context shown under the title: the trade-off, or what you already found.',
          },
          options: {
            type: 'array',
            description: '2-4 concrete options the user can pick from.',
            minItems: 1,
            maxItems: 8,
            items: {
              type: 'object',
              properties: {
                id: { type: 'string', description: 'Unique within this question, e.g. "a".' },
                label: { type: 'string', description: 'Short button text, e.g. "方案 A：先做转账".' },
                description: {
                  type: 'string',
                  description: 'Optional one-line trade-off shown under the label.',
                },
                prompt: {
                  type: 'string',
                  description:
                    'Optional instruction you will receive in the tool result when this option is picked.',
                },
                command: {
                  type: 'string',
                  description:
                    'Optional shell command to run immediately when this option is picked (cwd = session cwd). Its output is returned to you.',
                },
              },
              required: ['id', 'label'],
              additionalProperties: false,
            },
          },
          multiple: { type: 'boolean', description: 'Allow picking more than one option.' },
          allowCustom: {
            type: 'boolean',
            description:
              'The card shows a free-text field by default, so the user can always type their own answer instead of picking. Set `false` only when the decision is strictly one of the listed options.',
          },
          timeoutMs: {
            type: 'number',
            description:
              'How long to wait before giving up (default 15 minutes, max 1 hour). The result is `cancelled` on timeout.',
          },
          summary: {
            type: 'string',
            description:
              'Very short label for the session list while waiting, e.g. "等你选入口". Defaults to `title`.',
          },
          presentation: {
            type: 'string',
            enum: ['dock', 'modal'],
            description:
              'Where to draw it: `dock` (default) sits above the composer; `modal` is a centered dialog for something that should interrupt, e.g. "上下文快满了，现在压缩吗".',
          },
          ui: {
            type: 'object',
            description:
              'Turn individual elements on or off. Omit to let them follow the data (e.g. the input box only disappears with `allowCustom: false`).',
            properties: {
              icon: { type: 'boolean', description: 'The leading question mark badge.' },
              meta: { type: 'boolean', description: 'The "2 options · single choice" line next to the title.' },
              detail: { type: 'boolean', description: 'The detail paragraph.' },
              options: { type: 'boolean', description: 'The option list.' },
              input: { type: 'boolean', description: 'The free-text field.' },
              confirm: { type: 'boolean', description: 'The explicit 确定 button (needed when a pick is not final).' },
              hint: { type: 'boolean', description: 'The "已选 A" line in the footer.' },
              dismiss: { type: 'boolean', description: 'The close button that cancels the question.' },
            },
            additionalProperties: false,
          },
        },
        required: ['title', 'options'],
        additionalProperties: false,
      },
      { readOnly: true },
    );
  }

  async execute(input: ToolInput, callbacks?: ToolExecuteCallbacks): Promise<string> {
    const question = toQuestion(input);
    let answer: PluginAskAnswer;
    try {
      answer = await this.ask.request(question, { signal: callbacks?.signal });
    } catch (error) {
      return `没能把问题交给用户：${error instanceof Error ? error.message : String(error)}`;
    }
    if (answer.cancelled) return cancelledText(answer);
    return await answeredText(question, answer);
  }

  onToolUseDisplayText(input: ToolInput): string {
    const title = typeof input?.title === 'string' ? input.title.trim() : '';
    return title ? `Asking: ${title}` : 'Asking the user';
  }
}

function toQuestion(input: ToolInput): PluginAskQuestion {
  const options = Array.isArray(input?.options) ? input.options : [];
  // 数字从 JSON 进来可能是字符串；`null` / `''` / `0` 这类「非正数」一律当没给，
  // 交给宿主按默认 15 分钟处理——`Number(null)` 是 0，照收就变成 1 秒超时，用户还没看到
  // 卡片它就没了。
  const asked = Number(input?.timeoutMs);
  const timeoutMs = Number.isFinite(asked) && asked > 0 ? asked : undefined;
  return {
    title: String(input?.title ?? ''),
    detail: typeof input?.detail === 'string' ? input.detail : undefined,
    options: options as PluginAskOption[],
    multiple: input?.multiple === true,
    ...(typeof input?.allowCustom === 'boolean' ? { allowCustom: input.allowCustom } : {}),
    presentation: input?.presentation === 'modal' ? 'modal' : undefined,
    ...(input?.ui && typeof input.ui === 'object'
      ? { ui: input.ui as PluginAskQuestion['ui'] }
      : {}),
    timeoutMs,
    summary: typeof input?.summary === 'string' ? input.summary : undefined,
  };
}

function cancelledText(answer: PluginAskAnswer): string {
  const why =
    answer.reason === 'timeout'
      ? '等了一会儿没有回应'
      : answer.reason === 'aborted'
        ? '用户中止了这一轮'
        : '用户没有选';
  return `${why}。不要重复问同一个问题：按最保守的方案继续，并在回复里说明你选了哪个、为什么。`;
}

async function answeredText(question: PluginAskQuestion, answer: PluginAskAnswer): Promise<string> {
  const picked = answer.optionIds
    .map((id) => question.options.find((option) => option.id === id))
    .filter((option): option is PluginAskOption => Boolean(option));
  const lines: string[] = [];
  const custom = answer.custom?.trim() ?? '';

  if (picked.length === 0 && !custom) {
    return '用户没有选中任何选项，也没有补充说明。按最保守的方案继续，并说明你选了哪个。';
  }

  if (picked.length === 1) lines.push(`用户选择了「${picked[0].label}」。`);
  else if (picked.length > 1) {
    lines.push(`用户选择了：${picked.map((option) => `「${option.label}」`).join('、')}。`);
  }

  for (const option of picked) {
    const prompt = option.prompt?.trim();
    if (prompt) lines.push('', `按这个选项继续：${prompt}`);
    const command = option.command?.trim();
    if (command) {
      lines.push('', `用户的选择要求执行：\`${command}\``);
      lines.push('执行结果：', await runCommand(command));
    }
  }

  if (custom) lines.push('', `用户的补充：${custom}`);
  return lines.join('\n').trim();
}

/**
 * 跑选项上的命令。
 *
 * 失败不是工具失败：用户已经选了这条路，把 stderr / 退出码交回模型，由它决定是修一下
 * 再跑、还是回来重新问。执行前一件事**不能**做——把命令当成用户的授权去静默重试。
 */
function runCommand(command: string): Promise<string> {
  return new Promise((resolve) => {
    execFile(
      '/bin/bash',
      ['-lc', command],
      { cwd: process.cwd(), timeout: COMMAND_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 },
      (error, stdout, stderr) => {
        const output = `${stdout || ''}${stderr || ''}`.trim();
        if (error) {
          const reason = error.killed ? '执行超时被终止' : error.message;
          resolve(truncate(`执行失败（${reason}）${output ? `\n${output}` : ''}`));
          return;
        }
        resolve(truncate(output || '（没有输出）'));
      },
    );
  });
}

function truncate(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length <= MAX_COMMAND_OUTPUT) return trimmed;
  return `${trimmed.slice(0, MAX_COMMAND_OUTPUT)}\n…（输出已截断，共 ${trimmed.length} 字符）`;
}
