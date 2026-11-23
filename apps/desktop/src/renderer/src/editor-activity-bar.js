/** 活动栏上的面板 id（顺序就是画出来的顺序）。 */
export const ACTIVITY_PANELS = ['explorer', 'search', 'git', 'git-tree', 'git-graph']

/**
 * 点一个活动栏图标之后，面板与侧栏各自该是什么样。
 *
 * - 点当前项＝收起整块侧栏，再点一次同一个图标把它放回来（VS Code 的活动栏语义）。
 * - 侧栏收着时点任何一项都先把它放回来，切到那一项。
 * - Git 图谱是整页：收起它等于关掉这一页，所以顺带把面板切回资源管理器，
 *   否则下次展开会看到一片空白。
 * - 手机上侧栏与编辑器互相占满，收起会留下一张没有任何入口的空白页，那里沿用旧规则：
 *   再点当前项回到资源管理器，侧栏始终可见。
 */
export function planActivityBarClick({ panel, activePanel, collapsed = false, mobile = false }) {
  if (mobile) return { panel: activePanel === panel ? 'explorer' : panel, collapsed: false }
  if (collapsed) return { panel, collapsed: false }
  if (activePanel !== panel) return { panel, collapsed: false }
  return { panel: panel === 'git-graph' ? 'explorer' : panel, collapsed: true }
}
