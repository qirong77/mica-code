import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PluginContext } from '@packages/mica-plugin/index.js';
import { micaSkills } from '@packages/mica-skills/index.js';
import SKILL_MD from './skill/SKILL.md' with { type: 'text' };
import { registerBridgeSupervisor } from './BridgeSupervisor.js';
import { createPanelHandler } from './Panel.js';
import { runPageSync } from './PageSyncAction.js';
import { MobileRelayTool } from './MobileRelayTool.js';
import { registerMachine } from './registerMachine.js';

const SKILL_NAME = 'mobile-relay';

/**
 * 内置 skill：把「怎么部署中转机」讲清楚，让 agent 现场去做。
 *
 * 中转机的部署不进插件代码——脚本在仓库里，agent 缺什么装什么、要构建就构建。
 * 插件只负责本机这座桥，两件事因此不会互相拖累版本。
 */
function registerSkill(ctx: PluginContext, dataDir: string | null): void {
  const skills = ctx.skills;
  if (!skills || !dataDir) return;

  // skill 的 baseDir 必须是一个真能读到的目录（索引与 `skill` 工具都从它取文件）。
  // 内容随包内嵌，落到插件自己的数据目录下，不去碰用户的 skills 目录。
  const baseDir = join(dataDir, 'skill');
  const skillContent = SKILL_MD;
  try {
    mkdirSync(baseDir, { recursive: true });
    writeFileSync(join(baseDir, 'SKILL.md'), skillContent, 'utf8');
  } catch (error) {
    ctx.health.report({
      level: 'warn',
      message: `skill 落盘失败：${error instanceof Error ? error.message : String(error)}`,
      hint: `检查 ${baseDir} 是否可写`,
    });
    return;
  }

  const meta = micaSkills.parseMarkdown(skillContent);
  const registration = skills.register({
    name: meta.name || SKILL_NAME,
    description: meta.description || SKILL_NAME,
    whenToUse: meta.whenToUse,
    argumentHint: meta.argumentHint,
    content: skillContent,
    baseDir,
  });

  if (registration.skipped.length > 0) {
    const names = registration.skipped.map((entry) => entry.name).join('、');
    ctx.logger.warn('mobile-relay:skill-shadowed', { names });
    ctx.health.report({
      level: 'warn',
      message: `内置 skill 被磁盘上的同名 skill 覆盖（${names}）`,
      hint: '删掉 $MICA_HOME/skills 下的同名目录后重开会话，才会用内置这份。',
    });
  }
}

export default function setup(ctx: PluginContext): void {
  // 桥的启停跟着插件走：停用插件就杀掉那个常驻进程，不留任何还在外联的东西。
  // 数据目录跟插件的其余状态一致放在 `$MICA_HOME/plugin-data/<id>`（`paths.config` 就是
  // MICA_HOME；`paths.home` 是系统 home，写到那里会污染用户目录）。
  const dataDir = ctx.paths?.config ? join(ctx.paths.config, 'plugin-data', 'mobile-relay') : null;

  registerSkill(ctx, dataDir);
  registerBridgeSupervisor(ctx, dataDir);
  registerPanel(ctx, dataDir);
  registerActions(ctx, dataDir);

  const tools = ctx.tools;
  if (!tools) {
    // 一次性动作宿主（配置页按钮）只有 actions，没有 tools。缺能力是宿主的事实，
    // 由 requires 与 plugin-status 表达，不该写成插件的健康告警。
    ctx.logger.info('mobile-relay:no-tools', {});
    return;
  }
  tools.register(new MobileRelayTool(ctx));
}

/**
 * 配置页上的按钮（清单 `actions`）：在插件设置下方直接点，不跳去对话。
 *
 * 执行它的是一个一次性插件进程，因此这里不能假设有会话、有桥在跑——只读设置、
 * 发一次注册请求、把口令写回设置。
 */
function registerActions(ctx: PluginContext, dataDir: string | null): void {
  const actions = ctx.actions;
  if (!actions) return;
  actions.register('register', async ({ values }) => registerMachine(ctx, values, dataDir));
  actions.register('sync-page', async () => runPageSync(ctx, dataDir));
}

/**
 * 对话右侧的面板：接入中转机、看状态、开关桥。
 *
 * 声明在清单 `desktop.panel` 里，内容全由插件给数据、宿主渲染，所以用户插件也能用。
 * 只有桌面宿主提供 `ctx.desktop`；CLI / `mica exec` 里没有这块界面，跳过即可。
 */
function registerPanel(ctx: PluginContext, dataDir: string | null): void {
  const panel = ctx.desktop?.panel;
  if (!panel) return;
  panel.call(ctx.desktop, createPanelHandler(ctx, dataDir));
}
