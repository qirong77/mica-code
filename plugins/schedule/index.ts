import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolveMicaHome } from '@packages/mica-config/brand.js';
import type { PluginContext } from '@packages/mica-plugin/index.js';
import { micaSkills } from '@packages/mica-skills/index.js';
import SKILL_MD from './skill/SKILL.md' with { type: 'text' };
import { ScheduleTool } from './ScheduleTool.js';
import { SCHEDULE_DATA_FILE } from './store.js';

/**
 * `schedule`：这台机器上的一份本地排期。
 *
 * 它不属于任何聊天工具——数据就在 `$MICA_HOME/plugin-data/schedule/data.json`，两个入口改
 * 同一份：桌面端整页甘特图（拖条、建任务、写备注），和 `schedule` 工具（用户跟模型说一句
 * 「把联调推到下周」）。随包 skill 讲清楚怎么用那个工具，所以模型不需要用户教它字段。
 */

const SKILL_NAME = 'schedule';

function registerSkill(ctx: PluginContext, dataDir: string): void {
  const skills = ctx.skills;
  if (!skills) return;
  // skill 的 baseDir 必须是真能读到的目录：`/` 补全插入的是 `baseDir/SKILL.md` 的路径，
  // 文件不在就不会出现在列表里。正文随包内嵌，落到插件自己的数据目录，不去碰用户的
  // skills 目录（那边同名会覆盖内置这份，这是既定优先级）。
  const baseDir = join(dataDir, 'skill');
  try {
    mkdirSync(baseDir, { recursive: true });
    writeFileSync(join(baseDir, 'SKILL.md'), SKILL_MD, 'utf8');
  } catch (error) {
    ctx.health.report({
      level: 'warn',
      message: `skill 落盘失败：${error instanceof Error ? error.message : String(error)}`,
      hint: `检查 ${baseDir} 是否可写`,
    });
    return;
  }

  const meta = micaSkills.parseMarkdown(SKILL_MD);
  const registration = skills.register({
    name: meta.name || SKILL_NAME,
    description: meta.description || SKILL_NAME,
    whenToUse: meta.whenToUse,
    argumentHint: meta.argumentHint,
    content: SKILL_MD,
    baseDir,
  });
  if (registration.skipped.length > 0) {
    const names = registration.skipped.map((entry) => entry.name).join('、');
    ctx.logger.warn('schedule:skill-shadowed', { names });
    ctx.health.report({
      level: 'warn',
      message: `内置 skill 被磁盘上的同名 skill 覆盖（${names}）`,
      hint: '删掉 $MICA_HOME/skills 下的同名目录后重开会话，才会用内置这份。',
    });
  }
}

export default function setup(ctx: PluginContext): void {
  const tools = ctx.tools;
  if (!tools) throw new Error('schedule 需要宿主提供 tools 能力');

  const dataDir = join(ctx.paths?.config ?? resolveMicaHome(), 'plugin-data', ctx.pluginId);
  const tool = tools.register(new ScheduleTool(join(dataDir, SCHEDULE_DATA_FILE)), {
    icon: '📅',
    // 排期是「用户的东西」：子代理临时被派去查东西时顺手改一条，用户根本不知道谁改的。
    primaryAgentOnly: true,
  });
  ctx.onDispose(() => tool.dispose());

  registerSkill(ctx, dataDir);
  ctx.logger.info('schedule:ready', { dataDir });
}
