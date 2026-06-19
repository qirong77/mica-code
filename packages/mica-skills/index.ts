import { getLoadedSkills, reloadSkills } from './loadSkills.js';

export const micaSkills = {
  /** 返回当前已加载的 skills 列表。 */
  getLoaded: getLoadedSkills,
  /** 重新扫描并加载 skills，用于用户新增或修改 skill 后刷新运行时状态。 */
  reload: reloadSkills,
};

export type { Skill } from './types.js';
