import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { PluginAskApi, PluginAskQuestion } from '@packages/mica-plugin/index.js';
import type { PluginToolDescriptor } from '@packages/mica-tools/PluginTool.js';
import type { ToolExecuteCallbacks, ToolInput } from '@packages/mica-tools/index.js';

/**
 * `computer_use`：模型操作 macOS 桌面的**唯一入口**。
 *
 * 为什么不是「让模型直接 shell 调 desktop.mjs」：那等于模型可以随时接管用户的鼠标和键盘，
 * 而用户看不到、也拦不住。这里把一次调用做成「一批步骤 + 一次确认」：
 *
 * 1. 只读命令（元素树、读文本、截图、列屏幕…）直接跑；
 * 2. 只要有一条规定要改屏幕/键盘的命令，就先弹一张确认卡，用户点「允许」才继续；
 * 3. 允许之后写一个**一次性许可文件**（内容是这次批准的具体命令，每条只能消费一次），
 *    再带着它去跑 desktop.mjs —— 运行时那边同样会校验，所以绕过工具的 shell 调用会失败。
 *
 * 许可文件不是安全边界（模型理论上能自己造一个），它的目标是让「没问过用户就动手」变成
 * 一条立刻失败的路径，而不是悄悄发生。
 */

export const COMPUTER_USE_TOOL_NAME = 'computer_use';

/** 一次调用最多几步：再多就不是「一次操作」，而是应该拆成几轮、每轮重新确认。 */
const MAX_STEPS = 20;
const MAX_OUTPUT = 8000;
const STEP_TIMEOUT_MS = 120_000;
/** 许可只在「刚批准的这一批」内有效，过期就重新问。 */
const PERMIT_TTL_MS = 120_000;
/** 确认卡不等人太久：等不到回答就当作没批准。 */
const ASK_TIMEOUT_MS = 120_000;

type Step = { cmd: string; args: string[] };
type CommandSets = { write: Set<string>; read: Set<string> };

export type ComputerUseToolDeps = {
  /** 运行时目录（`scripts/desktop.mjs` 在里面）。 */
  runtimeDir: string;
  /** 没有它就拿不到用户确认，写操作一律拒绝（只读命令照旧）。 */
  ask?: PluginAskApi;
  /** 测试用：替换 `node` 可执行文件。 */
  nodeBin?: string;
};

const commandSetCache = new Map<string, CommandSets | null>();

function nodeBin(deps: ComputerUseToolDeps): string {
  return deps.nodeBin || process.env.MICA_COMPUTER_USE_NODE || 'node';
}

function scriptPath(deps: ComputerUseToolDeps): string {
  return join(deps.runtimeDir, 'scripts', 'desktop.mjs');
}

/**
 * 哪些命令会改动用户环境：单一事实来源是 runtime 自己的 `commands`（同一份表也用于门禁）。
 * 读不到就返回 null——那说明 runtime 缺文件或 node 不可用，比按猜测分类安全。
 */
function commandSets(deps: ComputerUseToolDeps): CommandSets | null {
  const script = scriptPath(deps);
  if (commandSetCache.has(script)) return commandSetCache.get(script)!;
  const r = spawnSync(nodeBin(deps), [script, 'commands', '--json'], { encoding: 'utf8', timeout: 20_000 });
  let sets: CommandSets | null = null;
  if (r.status === 0) {
    try {
      const parsed = JSON.parse(String(r.stdout || ''));
      if (Array.isArray(parsed?.write) && Array.isArray(parsed?.read)) {
        sets = {
          write: new Set(parsed.write.map(String)),
          read: new Set(parsed.read.map(String)),
        };
      }
    } catch {
      sets = null;
    }
  }
  // 失败不缓存：runtime 可能只是这一瞬间不可用（刚落盘、node 还没就绪）
  if (sets) commandSetCache.set(script, sets);
  return sets;
}

function asText(value: unknown): string {
  return typeof value === 'string' ? value : value === undefined || value === null ? '' : String(value);
}

function parseSteps(input: ToolInput): { steps: Step[]; error?: string } {
  const raw = input?.commands;
  if (!Array.isArray(raw) || raw.length === 0) {
    return { steps: [], error: '缺少 commands：给一个步骤数组，例如 [{ "cmd": "tap", "args": ["Calculator", "乘"] }]。' };
  }
  if (raw.length > MAX_STEPS) {
    return { steps: [], error: `一次最多 ${MAX_STEPS} 步（收到 ${raw.length} 步），拆成几次调用。` };
  }
  const steps: Step[] = [];
  for (const [index, entry] of raw.entries()) {
    if (!entry || typeof entry !== 'object') {
      return { steps: [], error: `第 ${index + 1} 步不是对象。` };
    }
    const cmd = asText((entry as Record<string, unknown>).cmd).trim();
    if (!cmd) return { steps: [], error: `第 ${index + 1} 步缺少 cmd。` };
    const rawArgs = (entry as Record<string, unknown>).args;
    if (rawArgs !== undefined && !Array.isArray(rawArgs)) {
      return { steps: [], error: `第 ${index + 1} 步的 args 必须是字符串数组。` };
    }
    const args = Array.isArray(rawArgs) ? rawArgs.map((value) => asText(value)) : [];
    steps.push({ cmd, args });
  }
  return { steps };
}

const short = (text: string, max = 40): string => (text.length <= max ? text : `${text.slice(0, max)}…`);

/** 确认卡上的那一步人话：用户要能一眼看出「它要在我屏幕上做什么」。 */
export function describeStep(step: Step): string {
  const [a, b, c, d, e] = step.args;
  switch (step.cmd) {
    case 'tap':
      return `点击「${a ?? '?'}」里的「${b ?? '?'}」（后台 AXPress，不动鼠标）`;
    case 'setval':
      return `把「${a ?? '?'}」的「${b ?? '?'}」写成 "${short(c ?? '')}"`;
    case 'type':
      return `键入 "${short(step.args.join(' '))}"`;
    case 'paste':
      return `粘贴 "${short(step.args.join(' '))}"（会改剪贴板）`;
    case 'key':
      return `按 ${a ?? '?'} 键`;
    case 'press':
      return `按组合键 ${a ?? '?'}`;
    case 'move':
      return `把鼠标移到 ${a ?? '?'},${b ?? '?'}`;
    case 'click':
    case 'dclick':
    case 'rclick': {
      const name = step.cmd === 'dclick' ? '双击' : step.cmd === 'rclick' ? '右键点击' : '点击';
      return a === undefined ? `${name}鼠标当前位置` : `${name} ${a},${b}`;
    }
    case 'drag':
      return `从 ${a ?? '?'},${b ?? '?'} 拖到 ${c ?? '?'},${d ?? '?'}${e ? `（${e}ms）` : ''}`;
    case 'scroll':
      return `向 ${a ?? 'down'} 滚动 ${b ?? 3} 格`;
    case 'focus':
      return `把「${a ?? '?'}」切到前台（会抢焦点）`;
    case 'launch':
      return `启动「${a ?? '?'}」`;
    case 'clip':
      return `把一段文字写进剪贴板`;
    default:
      return `${step.cmd}${step.args.length ? ` ${step.args.join(' ')}` : ''}`;
  }
}

function approvalQuestion(goal: string, steps: Step[]): PluginAskQuestion {
  const lines = steps.map((step, index) => `${index + 1}. ${describeStep(step)}`);
  return {
    title: goal ? `允许「${short(goal, 60)}」吗？` : '允许这次桌面操作吗？',
    detail:
      `将执行 ${steps.length} 步：\n${lines.join('\n')}\n\n` +
      '鼠标、键盘或应用焦点会被真实占用，可能打断你正在做的事。',
    options: [
      { id: 'allow', label: `允许这 ${steps.length} 步` },
      { id: 'deny', label: '不要执行' },
    ],
    allowCustom: false,
    presentation: 'dock',
    summary: '等你确认桌面操作',
    timeoutMs: ASK_TIMEOUT_MS,
    ui: { input: false, meta: false, dismiss: true },
  };
}

function writePermit(steps: Step[]): { dir: string; path: string } {
  const dir = mkdtempSync(join(tmpdir(), 'mica-computer-use-'));
  const path = join(dir, 'permit.json');
  const now = Date.now();
  writeFileSync(
    path,
    JSON.stringify({
      v: 1,
      createdAt: now,
      expiresAt: now + PERMIT_TTL_MS,
      entries: steps.map((step) => ({ key: JSON.stringify([step.cmd, ...step.args]), used: false })),
    }),
    { encoding: 'utf8', mode: 0o600 },
  );
  return { dir, path };
}

type StepRun = { status: number; stdout: string; stderr: string };

function runStep(deps: ComputerUseToolDeps, step: Step, permitPath: string | null): StepRun {
  const env = { ...process.env };
  if (permitPath) env.MICA_COMPUTER_USE_APPROVAL = permitPath;
  else delete env.MICA_COMPUTER_USE_APPROVAL;
  const r = spawnSync(nodeBin(deps), [scriptPath(deps), step.cmd, ...step.args], {
    encoding: 'utf8',
    env,
    timeout: STEP_TIMEOUT_MS,
    maxBuffer: 32 * 1024 * 1024,
  });
  return {
    status: typeof r.status === 'number' ? r.status : 1,
    stdout: String(r.stdout || '').trim(),
    stderr: String(r.stderr || '').trim(),
  };
}

function truncate(text: string): string {
  if (text.length <= MAX_OUTPUT) return text;
  return `${text.slice(0, MAX_OUTPUT)}\n…（输出已截断，共 ${text.length} 字符）`;
}

export function createComputerUseTool(deps: ComputerUseToolDeps): PluginToolDescriptor {
  return {
    name: COMPUTER_USE_TOOL_NAME,
    description: [
      'Drive this Mac desktop: AX element tree (click a control by name, read text, read web pages) and CGEvent mouse/keyboard, plus screenshots of every display.',
      'Only use it when the user asks for desktop work in this turn ("点一下那个按钮", "帮我在浏览器里填表", "截图看看第二个屏幕"). Never reach for it on your own to look something up, and never as a shortcut for a task that the filesystem, a shell or a web fetch can answer.',
      'Call it with a batch of steps (cmd + args) that belong to one operation. Read-only commands (apps/front/screens/els/find/text/wait-el/windows/winlist/webtext/shot/winshot/size/pos/check) run immediately.',
      'Any command that changes the screen or keyboard (tap/setval/type/paste/key/press/move/click/dclick/rclick/drag/scroll/focus/launch/clip) triggers a confirmation card first; if the user does not approve, nothing runs. That card is the only way to get permission — running desktop.mjs yourself through a shell fails for exactly these commands.',
      'Prefer AX over coordinates (tap is background and does not steal focus). On multiple displays, run `screens` first: coordinates are global points across all displays, and plain screenshots capture every display (the first file is the one with the front window). Batch the verification step too (wait-el, text, webtext) so one approval covers the whole operation.',
    ].join(' '),
    input_schema: {
      type: 'object',
      properties: {
        goal: {
          type: 'string',
          description:
            'One line for the user: what this batch is for, e.g. "在计算器里算 123×456". It becomes the confirmation card title.',
        },
        commands: {
          type: 'array',
          minItems: 1,
          maxItems: MAX_STEPS,
          description:
            'Steps to run in order. Stop at the first failure. Each step is `{ cmd, args }`, args all strings.',
          items: {
            type: 'object',
            properties: {
              cmd: {
                type: 'string',
                description:
                  'Command name from `desktop.mjs help`: tap / setval / type / paste / key / press / move / click / dclick / rclick / drag / scroll / focus / launch / clip / wait / apps / front / screens / els / find / text / wait-el / windows / winlist / webtext / enable-ax / shot / winshot / size / pos / check.',
              },
              args: {
                type: 'array',
                items: { type: 'string' },
                description: 'Positional arguments, exactly like the CLI: ["Calculator", "乘"] for `tap`.',
              },
            },
            required: ['cmd'],
            additionalProperties: false,
          },
        },
      },
      required: ['commands'],
      additionalProperties: false,
    },
    readOnly: false,
    execute: async (input: ToolInput, callbacks?: ToolExecuteCallbacks): Promise<string> => {
      const parsed = parseSteps(input);
      if (parsed.error) return parsed.error;
      const { steps } = parsed;

      const sets = commandSets(deps);
      if (!sets) {
        return (
          `桌面运行时不可用：\`${scriptPath(deps)} commands --json\` 没跑起来。\n` +
          '检查 `$MICA_HOME/computer-use` 是否完整、`node` 是否在 PATH 上（也可以在插件详情里看运行条件）。'
        );
      }
      const unknown = steps.filter((step) => !sets.write.has(step.cmd) && !sets.read.has(step.cmd));
      if (unknown.length > 0) {
        return `未知命令：${unknown.map((step) => step.cmd).join('、')}。可用命令见 \`desktop.mjs help\`（写操作需要用户确认）。`;
      }

      const needsApproval = steps.some((step) => sets.write.has(step.cmd));
      if (needsApproval) {
        if (!deps.ask) {
          return (
            '当前宿主没法向用户确认，写操作被拒绝（只读命令可以照常调用）。' +
            '需要真的操作桌面请在 Mica 桌面端里发起。'
          );
        }
        const goal = asText(input?.goal).trim();
        let answer;
        try {
          answer = await deps.ask.request(approvalQuestion(goal, steps), { signal: callbacks?.signal });
        } catch (error) {
          return `没能把确认交给用户：${error instanceof Error ? error.message : String(error)}`;
        }
        if (answer.cancelled || !answer.optionIds.includes('allow')) {
          const why =
            answer.reason === 'timeout' ? '等了一会儿没有回应' : answer.reason === 'aborted' ? '用户中止了这一轮' : '用户没有批准';
          return `${why}，这次桌面操作没有执行，也没有发出任何鼠标或键盘事件。不要重试同一批命令：停下来问用户要怎么继续，或换一条不需要动键鼠的做法。`;
        }
      }

      const permit = needsApproval ? writePermit(steps) : null;
      const lines: string[] = [];
      try {
        for (const [index, step] of steps.entries()) {
          if (callbacks?.signal?.aborted) {
            lines.push(`第 ${index + 1} 步之前被中止（后面的命令没有执行）。`);
            break;
          }
          const result = runStep(deps, step, permit?.path ?? null);
          const head = `[${index + 1}/${steps.length}] ${step.cmd}${step.args.length ? ` ${step.args.join(' ')}` : ''}`;
          const body = [result.stdout, result.stderr ? `stderr: ${result.stderr}` : ''].filter(Boolean).join('\n');
          if (result.status !== 0) {
            lines.push(`${head} → 失败（exit=${result.status}）${body ? `\n${body}` : ''}`);
            const rest = steps.length - index - 1;
            if (rest > 0) lines.push(`后面的 ${rest} 步没有执行。`);
            break;
          }
          lines.push(`${head}\n${body}`);
        }
      } finally {
        if (permit) {
          try {
            rmSync(permit.dir, { recursive: true, force: true });
          } catch {
            // 删不掉不影响正确性：许可文件已经过期，且每条命令只能消费一次
          }
        }
      }
      return truncate(lines.join('\n\n'));
    },
    displayText: (input: ToolInput): string => {
      const goal = asText(input?.goal).trim();
      const count = Array.isArray(input?.commands) ? input.commands.length : 0;
      return goal ? `Desktop: ${goal}` : `Desktop: ${count} 步`;
    },
  };
}
