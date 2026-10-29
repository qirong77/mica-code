import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { resolveMicaHome } from '@packages/mica-config/brand.js';
import type { MicaPlugin, PluginContext } from '@packages/mica-plugin/index.js';
import { micaSkills } from '@packages/mica-skills/index.js';
import SKILL_MD from './skill/SKILL.md' with { type: 'text' };
import { SidecarRegistry } from './registry.js';
import {
  SidecarAbortTool,
  SidecarCloseTool,
  SidecarGrepTool,
  SidecarSendTool,
  SidecarSpawnTool,
  SidecarStatusTool,
  SidecarTranscriptTool,
  SidecarTurnsTool,
  SidecarWaitTool,
} from './tools.js';

/**
 * Sidecar：把「派一个独立的 mica 会话去干活，然后观测它」做成产品能力。
 *
 * 组成只有两块：
 * - **工具**（`sidecar_*`）：开子会话、投消息、看进度、等条件、打断、收掉。每个子会话
 *   是一个常驻的 `mica app-server` 进程——结构化事件流，不是点界面；
 * - **skill**（`skill/SKILL.md`）：什么时候该派、怎么派、怎么读结果的操作手册。
 *
 * 子会话在自己的会话文件里记 `parentSessionId`，桌面端侧栏据此把它嵌在父会话下面——
 * 用户不需要任何操作就能看到「这条会话派生出了谁」。
 *
 * 进程随插件一起收：父会话关掉，还在跑的子会话会被 `onDispose` 收掉，不会留下后台
 * 烧 token 的幽灵进程。
 */

export const RUNTIME_DIR_NAME = 'sidecar';

export const SKILL_NAME = 'sidecar';

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

const plugin: MicaPlugin = {
  id: 'sidecar',
  name: 'Sidecar',
  version: '1.0.0',
  priority: 205,
  required: false,
  setup(ctx: PluginContext) {
    if (!ctx.tools) throw new Error('sidecar requires ctx.tools');
    if (!ctx.skills) throw new Error('sidecar requires ctx.skills');
    if (!ctx.session) throw new Error('sidecar requires ctx.session');

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
      ctx.logger.info('sidecar:skill-ready', { runtimeDir, result });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      ctx.logger.error('sidecar:skill-write-failed', { error: message });
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
      ctx.logger.warn('sidecar:skill-shadowed', { names });
      ctx.health.report({
        level: 'warn',
        message: `内置 skill 被磁盘上的同名 skill 覆盖（${names}）`,
        hint: '删掉 $MICA_HOME/skills 下的同名目录后重开会话，才会用内置这份。',
      });
    }

    const registry = new SidecarRegistry(ctx, parentSessionId, defaultCwd, currentRole);
    // primaryAgentOnly：子代理不该再派生会话，否则会变成没人收的进程树。
    const options = { primaryAgentOnly: true } as const;
    const tools = [
      ctx.tools.register(new SidecarSpawnTool(registry), options),
      ctx.tools.register(new SidecarSendTool(registry), options),
      ctx.tools.register(new SidecarStatusTool(registry), options),
      ctx.tools.register(new SidecarTurnsTool(registry), options),
      ctx.tools.register(new SidecarGrepTool(registry), options),
      ctx.tools.register(new SidecarTranscriptTool(registry), options),
      ctx.tools.register(new SidecarWaitTool(registry), options),
      ctx.tools.register(new SidecarAbortTool(registry), options),
      ctx.tools.register(new SidecarCloseTool(registry), options),
    ];
    ctx.onDispose(async () => {
      for (const tool of tools) tool.dispose();
      // 子进程必须跟着插件一起走：父会话关掉还在跑的 sidecar 会一直烧 token，
      // 而用户已经看不到它了（它挂在一条已经结束的会话名下）。
      //
      // 这里必须 **await**：`disposeAll` 会等这个回调，而 app-server 在它返回后
      // 立刻 `process.exit` —— 用 `void` 等于在子进程还没死的时候就撒手。
      // graceMs 压到 800 是给退出路径留预算：正常子进程收到 stdin EOF 几十毫秒
      // 就退了，只有卡住的才走满 SIGTERM/SIGKILL 那段。
      await registry.closeAll(800);
    });

    if (!registration.skipped.length) {
      ctx.health.report({
        level: 'ok',
        message: '可以派生并观测子会话',
        hint: '用法见 skill「sidecar」；子会话会挂在当前会话下面出现在侧栏。',
      });
    }
  },
};

export default function setup(ctx: PluginContext): void {
  plugin.setup(ctx);
}
