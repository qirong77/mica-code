import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { resolveMicaHome } from '@packages/mica-config/brand.js';
import type { MicaPlugin, PluginContext } from '@packages/mica-plugin/index.js';
import { micaSkills } from '@packages/mica-skills/index.js';
import SKILL_MD from './skill/SKILL.md' with { type: 'text' };
import { renderSubagentEvents, type SubagentEvent } from './events.js';
import { createPanelHandler } from './panel.js';
import { SubagentRegistry } from './registry.js';
import { shouldWake, SubagentWaker } from './wake.js';
import {
  SubagentDriveTool,
  SubagentInspectTool,
  SubagentStopTool,
  SubagentWaitTool,
} from './tools.js';

/**
 * Subagent：把「派一个独立的 mica 会话去干活，然后观测它」做成产品能力。
 *
 * 组成只有两块：
 * - **工具**（`subagent_*`）：开子会话、投消息、看进度、等条件、打断、收掉。每个子会话
 *   是一个常驻的 `mica app-server` 进程——结构化事件流，不是点界面；
 * - **skill**（`skill/SKILL.md`）：什么时候该派、怎么派、怎么读结果的操作手册。
 *
 * 子会话在自己的会话文件里记 `parentSessionId`，桌面端侧栏据此把它嵌在父会话下面——
 * 用户不需要任何操作就能看到「这条会话派生出了谁」。
 *
 * 进程随插件一起收：父会话关掉，还在跑的子会话会被 `onDispose` 收掉，不会留下后台
 * 烧 token 的幽灵进程。
 */

export const RUNTIME_DIR_NAME = 'subagent';

export const SKILL_NAME = 'subagent';

const SKILL = micaSkills.parseMarkdown(SKILL_MD);

const SKILL_FILE = 'SKILL.md';

export function resolveRuntimeDir(configDir?: string): string {
  return join(configDir || resolveMicaHome(), RUNTIME_DIR_NAME);
}

/** 落盘 SKILL.md：`skill` 工具与桌面端的 `/` 补全都要读真实的绝对路径。 */
export function materializeSkill(dir: string, content: string): 'written' | 'unchanged' {
  const target = join(dir, SKILL_FILE);
  if (existsSync(target)) {
    try {
      if (readFileSync(target, 'utf-8') === content) return 'unchanged';
    } catch {
      // 读不了就当需要重写，写失败会在下面抛出来。
    }
  }
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content, 'utf-8');
  return 'written';
}

/** 分钟 → 毫秒，容错：设置项里填了空、填了 0 或负数都按「不启用」处理。 */
function minutesToMs(value: unknown, fallbackMinutes: number): number {
  const number = Number(value);
  const minutes = Number.isFinite(number) ? number : fallbackMinutes;
  return Math.max(0, Math.round(minutes * 60_000));
}

/**
 * 事件是否值得在会话里留一条 notice。
 *
 * prompt 段落只给模型看；用户需要的是「它跑完了」「它卡住了」这种能扫一眼就知道的事。
 * 每一轮都发一条会把对话淹掉，所以只留真正改变结论的那几种。
 */
function shouldNotify(event: SubagentEvent): boolean {
  return event.kind === 'exit' || event.kind === 'stalled';
}

const plugin: MicaPlugin = {
  id: 'subagent',
  name: 'Subagent',
  version: '3.0.0',
  priority: 205,
  required: false,
  setup(ctx: PluginContext) {
    if (!ctx.tools) throw new Error('subagent requires ctx.tools');
    if (!ctx.skills) throw new Error('subagent requires ctx.skills');
    if (!ctx.session) throw new Error('subagent requires ctx.session');

    const describe = ctx.session.describe();
    const parentSessionId = describe?.id ?? null;
    const defaultCwd = describe?.cwd || process.cwd();
    // 父会话当前的角色。每次 spawn 重新读：会话里切角色（`/role`、输入条）之后
    // 再派子会话，应该跟的是切完的那个。
    const currentRole = () => ctx.session?.describe()?.role;

    const runtimeDir = resolveRuntimeDir(ctx.paths?.config);
    const skillContent = SKILL.content;
    try {
      const result = materializeSkill(runtimeDir, skillContent);
      ctx.logger.info('subagent:skill-ready', { runtimeDir, result });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      ctx.logger.error('subagent:skill-write-failed', { error: message });
      ctx.health.report({
        level: 'error',
        message: `skill 落盘失败：${message}`,
        hint: `检查 ${runtimeDir} 是否可写。`,
      });
      return;
    }

    const registration = ctx.skills.register({
      name: SKILL.name || SKILL_NAME,
      description: SKILL.description || SKILL_NAME,
      whenToUse: SKILL.whenToUse,
      argumentHint: SKILL.argumentHint,
      content: skillContent,
      baseDir: runtimeDir,
    });

    if (registration.skipped.length) {
      // 磁盘上有同名 skill 时优先用磁盘那份。工具仍然注册（它们是产品能力），
      // 但要让用户知道模型读到的手册不是随包这份。
      const names = registration.skipped.map((entry) => entry.name).join('、');
      ctx.logger.warn('subagent:skill-shadowed', { names });
      ctx.health.report({
        level: 'warn',
        message: `内置 skill 被磁盘上的同名 skill 覆盖（${names}）`,
        hint: '删掉 $MICA_HOME/skills 下的同名目录后重开会话，才会用内置这份。',
      });
    }

    // 插件设置：两项阈值都从设置里读，改完立刻生效（不走重启）。
    const readSettings = () => (ctx.settings?.get?.() ?? {}) as Record<string, unknown>;
    // 自动唤醒：默认开。关掉它，事件仍然会进下一轮的 prompt 段落，只是父会话空闲时
    // 不会自己起来处理——用户得自己回来问一句。
    const wakeEnabled = () => readSettings().wake !== 'false';
    // 当前是不是父会话的一轮在跑。轮中不提交新输入：事件等 turn:after 再送，
    // 不打断正在跑的活。turn:before / turn:after 在所有常驻宿主里都会发。
    let inTurn = false;
    // 上一次「还有 N 个在跑」提示的会话集合：同一批只提示一次，收掉一个才更新。
    let lastRunningKey = '';
    // 插件面向宿主时用会话 owner 隔离队列：TUI 里有多个 agent，空对象会永远判成空闲。
    const queueOwner = () => (ctx.session?.captureOwner?.() ?? null) as object | null;
    const canWake = () =>
      wakeEnabled() && ctx.agent?.mode !== 'one-shot' && typeof ctx.runtime?.submit === 'function';
    const registry = new SubagentRegistry(ctx, parentSessionId, defaultCwd, currentRole, {
      limits: () => {
        const values = readSettings();
        return {
          stallMs: minutesToMs(values.stallMinutes, 5),
          recycleMs: minutesToMs(values.recycleMinutes, 0),
        };
      },
      onEvent: (event) => {
        // 自动唤醒与「用户可见的提醒」是两件事：notify 关掉只少一条 notice，
        // 不该让父会话在空闲时收不到结果。轮中的事件先攒着，turn:after 再送。
        if (canWake() && shouldWake(event)) waker.schedule();
        // 用户看的那一条：只在「结果变了」的时候发，每一轮都发会把对话淹掉。
        if (readSettings().notify === 'false') return;
        if (!shouldNotify(event)) return;
        ctx.ui?.notice(
          [
            `子会话「${event.title}」${event.kind === 'exit' ? '进程已退出' : '可能卡住了'}：${event.summary}`,
            event.detail ? `\n${event.detail}` : '',
          ].join(''),
          { command: 'subagent', status: event.kind === 'stalled' ? 'warning' : 'info', surface: 'conversation' },
        );
      },
    });
    // 唤醒器单独一层：「记录事件」永远发生，「送达」要父会话有空、用户在等。
    // 提交走 `source: 'system'`：模型看到的是系统事件，不会被伪装成用户发言；
    // 用户在界面上看到的是下面那条 notice + 模型的新一轮回答。
    const waker = new SubagentWaker({
      inTurn: () => inTurn,
      busy: () => {
        const owner = queueOwner();
        return owner ? Boolean(ctx.runtime?.queue?.isBusy?.(owner)) : false;
      },
      draft: () => ctx.ui?.input?.getText?.() ?? '',
      queued: () => {
        const owner = queueOwner();
        return owner ? (ctx.runtime?.queue?.list?.(owner)?.length ?? 0) : 0;
      },
      peek: () => registry.peekEvents(),
      consume: (ids) => registry.dropEvents(ids),
      submit: async (text, displayText) => {
        if (!ctx.runtime?.submit) return false;
        const result = await ctx.runtime.submit(text, { source: 'system', displayText });
        return result.ok;
      },
      notice: (text) => ctx.ui?.notice(text, { command: 'subagent', status: 'info', surface: 'conversation' }),
    });

    // 一轮结束时做两件事：撤掉「这一轮在跑」标记并把攒下的事件送出去；还有子会话在跑
    // 就留一条提示——用户才知道本轮不是最终交付，跑完会自动回来。
    const turnBefore = ctx.hooks?.on?.(
      'turn:before',
      () => {
        inTurn = true;
      },
      { pluginId: ctx.pluginId },
    );
    const turnAfter = ctx.hooks?.on?.(
      'turn:after',
      () => {
        inTurn = false;
        if (readSettings().notify !== 'false') {
          const running = registry.liveRunning();
          const key = running.map((entry) => entry.id).sort().join(',');
          if (!running.length) {
            lastRunningKey = '';
          } else if (key !== lastRunningKey) {
            lastRunningKey = key;
            const titles = running.map((entry) => `「${entry.title}」`).join('、');
            ctx.ui?.notice(
              `这一轮结束，还有 ${running.length} 个子会话在跑：${titles}。` +
                '它们跑完/卡住会自动回到对话；关掉会话会连同它们一起中断。',
              { command: 'subagent', status: 'info', surface: 'conversation' },
            );
          }
        }
        // 0ms 之后再送：headless 宿主的 `running` 要等这一轮退出循环才清，
        // 在 turn:after 里直接 submit 会被排进单槽；失败/中止的轮次不会 drain 队列。
        if (canWake()) waker.flushSoon();
      },
      { pluginId: ctx.pluginId },
    );
    // primaryAgentOnly：子代理不该再派生会话，否则会变成没人收的进程树。
    // 图标整族一个（同 background_tasks_*）：它们说的是同一件事——一条被派出去的子会话。
    // 四个动词，一个主语：给活 / 看 / 等 / 停。同一件事的不同力度用参数表达，
    // 不再一档一个工具名——工具 schema 进每次请求的前缀，名字越少越省。
    const options = { icon: '🤖', primaryAgentOnly: true } as const;
    const tools = [
      ctx.tools.register(new SubagentDriveTool(registry), options),
      ctx.tools.register(new SubagentInspectTool(registry), options),
      ctx.tools.register(new SubagentWaitTool(registry), options),
      ctx.tools.register(new SubagentStopTool(registry), options),
    ];
    // 推送：子会话自己发生的事（跑完、退出、卡住）下一轮直接出现在 prompt 里。
    //
    // 放在其他插件段落之后（base prompt 的末尾），没有事件时渲染空串——整段消失，
    // 前缀不变，prompt cache 不白断。
    const section = ctx.prompt?.section({
      id: 'subagent-events',
      label: '子会话动态',
      order: 90,
      render: () => renderSubagentEvents(registry.takeEventsForPrompt()),
    });
    // 看门狗：停滞与空闲回收都需要一个钟——一个彻底卡住的子会话再也不会通知我们。
    const guard = ctx.background?.register({
      id: 'subagent-watch',
      every: 15_000,
      run: () => {
        registry.tick();
      },
    });
    // 面板：看得见也按得动（打断 / 收掉 / 看详情）。CLI 宿主没有桌面能力面，这里自然为空。
    const panel = ctx.desktop?.panel?.(createPanelHandler({ registry }));
    ctx.onDispose(async () => {
      waker.dispose();
      turnBefore?.dispose();
      turnAfter?.dispose();
      for (const tool of tools) tool.dispose();
      section?.dispose();
      guard?.dispose();
      panel?.dispose();
      // 子进程必须跟着插件一起走：父会话关掉还在跑的子会话会一直烧 token，
      // 而用户已经看不到它了（它挂在一条已经结束的会话名下）。
      //
      // 这里必须 **await**：`disposeAll` 会等这个回调，而 app-server 在它返回后
      // 立刻 `process.exit` —— 用 `void` 等于在子进程还没死的时候就撒手。
      // graceMs 给 3 秒：正常子进程收到 stdin EOF 几十毫秒就退，而正在写一篇长文、
      // 正在落盘一份结果的那一轮需要时间把状态存下来。父会话退出时多等几秒，
      // 换回来的是「会话文件里有它跑到哪」，而不是一条被打断的半截记录。
      await registry.closeAll(3_000);
    });

    if (!registration.skipped.length) {
      ctx.health.report({
        level: 'ok',
        message: '可以派生并观测子会话（跑完/卡住会自动报到，不设迭代、token、并发与嵌套上限）',
        hint: '用法见 skill「subagent」；子会话会挂在当前会话下面出现在侧栏，桌面端右侧面板可直接打断或收掉。',
      });
    }
  },
};

export default function setup(ctx: PluginContext): void {
  plugin.setup(ctx);
}
