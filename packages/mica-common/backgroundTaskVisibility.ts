/**
 * 后台任务是否留在状态栏。正常结束与被终止（模型调 `kill_background_task`、宿主退出
 * 时统一收尾）都在对话里交代过了，留着只会在输入框上方堆一排 killed；只有需要人看一眼的
 * 结束（失败的、退出码非零的、进程失踪的）才继续占位置。
 */
export function keepsBackgroundTaskRow(task: { status: string; exitCode?: number | null }): boolean {
  if (task.status === 'starting' || task.status === 'running') return true;
  if (task.status === 'killed') return false;
  if (task.status === 'finished') return task.exitCode != null && task.exitCode !== 0;
  return true;
}
