import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { resolveMicaHome } from '@packages/mica-config/brand.js';
import type { MicaPlugin, PluginContext } from '@packages/mica-plugin/index.js';
import { micaSkills } from '@packages/mica-skills/index.js';
import SKILL_MD from './skill/SKILL.md' with { type: 'text' };
import { COMPUTER_USE_RUNTIME_FILES } from './runtimeSources.js';

/**
 * Computer Use：把 macOS 桌面自动化做成一个随产品分发的内置能力。
 *
 * 三块组成，各自的落点不同：
 * - **skill**（`skill/SKILL.md`）：模型的操作手册，注册进运行期 skill 表，与用户自己的
 *   skill 完全同权（进 system prompt 索引、`skill` 工具能加载、能力开关能关掉）；
 * - **runtime**（`runtime/`）：`scripts/desktop.mjs` + `src/helper.m`，零 npm 依赖，
 *   AX 元素树与 CGEvent 键鼠都在 helper 里，首次用到时 clang 编译一次；
 * - **运行条件**：清单里的 `desktop.checks` 声明依赖哪几项权限/工具，桌面端探测后在
 *   配置页的插件详情里显示「开了没有 / 去哪开」。这里不渲染、也不探测——插件代码跑在
 *   app-server 子进程里，TCC 权限不属于它。
 *
 * runtime 与 SKILL.md 必须**落盘**才可用：skill 正文里要给出真实可执行的绝对路径，
 * helper 也要有稳定的编译产物位置。所以 setup 先把随包资源写到 `$MICA_HOME/computer-use`，
 * 再用落盘路径注册 skill。
 */

export const RUNTIME_DIR_NAME = 'computer-use';

export const SKILL_NAME = 'computer-use';

/** 元数据只有一份来源：SKILL.md 的 frontmatter。 */
const SKILL = micaSkills.parseMarkdown(SKILL_MD);

/** 落盘文件名（技能正文本身也落盘，用户/模型都能直接打开看）。 */
const SKILL_FILE = 'SKILL.md';

export function resolveRuntimeDir(configDir?: string): string {
  return join(configDir || resolveMicaHome(), RUNTIME_DIR_NAME);
}

/**
 * 把随包资源写到 `dir`，内容没变就不动文件。
 *
 * 「没变就不写」不是为了省 IO：helper 的编译缓存按源码 mtime 判断是否过期，
 * 每次启动都重写一遍会让每次启动都要重新 clang 编译。
 */
export function materializeRuntime(dir: string, skillContent: string): { written: string[]; unchanged: string[] } {
  const written: string[] = [];
  const unchanged: string[] = [];

  const files: Record<string, string> = {
    ...COMPUTER_USE_RUNTIME_FILES,
    [SKILL_FILE]: skillContent,
  };

  for (const [relPath, content] of Object.entries(files)) {
    const target = join(dir, relPath);
    if (existsSync(target)) {
      try {
        if (readFileSync(target, 'utf-8') === content) {
          unchanged.push(relPath);
          continue;
        }
      } catch {
        // 读不了就当成需要重写：写失败会在下面抛出来，比留一个坏文件好。
      }
    }
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content, 'utf-8');
    written.push(relPath);
  }

  return { written, unchanged };
}

/** skill 正文里的运行时路径占位符：换行无关，替换成真实绝对路径。 */
export function renderSkillContent(runtimeDir: string): string {
  // 落盘的 SKILL.md 也要替换：用户和 `skill` 工具读到的必须是同一份可执行正文。
  return SKILL.content.replaceAll('{{RUNTIME_DIR}}', runtimeDir);
}

const plugin: MicaPlugin = {
  id: 'computer-use',
  name: 'Computer Use',
  version: '1.0.0',
  priority: 210,
  required: false,
  setup(ctx: PluginContext) {
    if (process.platform !== 'darwin') {
      ctx.health.report({
        level: 'warn',
        message: `仅支持 macOS（当前为 ${process.platform}）`,
        hint: '这个能力依赖 macOS 的辅助功能与屏幕录制权限。',
      });
      return;
    }

    const runtimeDir = resolveRuntimeDir(ctx.paths?.config);
    const skillContent = renderSkillContent(runtimeDir);

    try {
      const result = materializeRuntime(runtimeDir, skillContent);
      ctx.logger.info('computer-use:runtime-ready', { runtimeDir, written: result.written.length });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      ctx.logger.error('computer-use:runtime-write-failed', { error: message });
      ctx.health.report({
        level: 'error',
        message: `运行时落盘失败：${message}`,
        hint: `检查 ${runtimeDir} 是否可写，或先删掉它让插件重建。`,
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

    if (registration.skipped.length > 0) {
      // 磁盘上有同名 skill（用户自己装的 mac-desktop-node 之类）时优先用磁盘那份：
      // 不静默——用户在能力页看到的开关得对得上实际生效的那一份。
      const names = registration.skipped.map((entry) => entry.name).join('、');
      ctx.logger.warn('computer-use:skill-shadowed', { names });
      ctx.health.report({
        level: 'warn',
        message: `内置 skill 被磁盘上的同名 skill 覆盖（${names}）`,
        hint: '删掉 $MICA_HOME/skills 下的同名目录后重开会话，才会用内置这份。',
      });
      return;
    }

    ctx.health.report({
      level: 'ok',
      message: '桌面自动化可用',
      hint: '权限没开时到 Settings → Plugins → Computer Use 的「运行条件」里查看状态并跳到系统设置。',
    });
  },
};

export default function setup(ctx: PluginContext): void {
  plugin.setup(ctx);
}
