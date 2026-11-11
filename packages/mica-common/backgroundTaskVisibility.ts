/** 状态栏只显示尚未结束的后台任务；任务记录和输出仍可单独查看。 */
export function keepsBackgroundTaskRow(task: { status: string; exitCode?: number | null }): boolean {
  return task.status === 'starting' || task.status === 'running';
}
