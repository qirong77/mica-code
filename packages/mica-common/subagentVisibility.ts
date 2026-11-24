/**
 * 子代理状态栏 / 任务面板只列**还在运行**的任务。
 *
 * 结束的任务（completed、跑到 maxTurns 的 partial、failed、以及模型或用户
 * kill 的）一律不占 dock：一次失败会在 dock 里留下一条再也点不掉的死行，攒几
 * 轮就把运行中的任务挤出视野。失败原因、部分结果与最近活动仍可从对话里那条
 * `agent` 工具结果读到，详情弹窗开着的话也照旧能「创建替代任务」。这个规则
 * 同时供 CLI 状态栏、app-server 快照和桌面投影使用，避免 renderer 自己猜状态。
 */
export function keepsSubagentTaskRow(task: { status: string }): boolean {
  return task.status === 'running';
}
