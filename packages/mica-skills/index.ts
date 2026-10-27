import {
  clearRuntimeSkills,
  getLoadedSkills,
  parseSkillMarkdown,
  registerRuntimeSkills,
  reloadSkills,
} from './loadSkills.js';

export const micaSkills = {
  /** 返回当前已加载的 skills 列表。 */
  getLoaded: getLoadedSkills,
  /** 重新扫描磁盘上的 skills，用于用户新增或修改 skill 后刷新运行时状态。 */
  reload: reloadSkills,
  /**
   * 注册运行期 skill（插件提供的内置能力）。磁盘上的同名 skill 优先，
   * 没注册上的条目从返回值的 `skipped` 里读。
   */
  registerRuntime: registerRuntimeSkills,
  /** 摘掉某个 owner 的全部运行期 skill。 */
  clearRuntime: clearRuntimeSkills,
  /** 解析一份 SKILL.md（frontmatter + 正文），插件内嵌 skill 正文时用它取元数据。 */
  parseMarkdown: parseSkillMarkdown,
};

export type { ParsedSkillMarkdown, RuntimeSkillRegistration } from './loadSkills.js';
export type { Skill } from './types.js';
