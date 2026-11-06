/** 子代理状态栏 / 任务面板只显示当前仍在运行的任务。 */
export function keepsSubagentTaskRow(task: { status: string; interrupted?: boolean }): boolean {
  return task.status === 'running';
}
