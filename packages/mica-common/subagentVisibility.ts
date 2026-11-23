/**
 * 子代理状态栏 / 任务面板显示仍有后续动作价值的任务。
 *
 * `completed` 和宿主正常收尾的 `killed` 不需要继续占用 dock；失败、跑到
 * maxTurns 的 partial、以及用户明确中止的任务则必须留下入口，用户才能读
 * 原因、查看部分结果或创建替代任务。这个规则同时供 CLI、app-server 和桌面
 * 投影使用，避免 renderer 自己猜状态。
 */
export function keepsSubagentTaskRow(task: { status: string; interrupted?: boolean }): boolean {
  return task.status === 'running' || task.status === 'failed' || task.status === 'partial' ||
    (task.status === 'killed' && task.interrupted === true);
}
