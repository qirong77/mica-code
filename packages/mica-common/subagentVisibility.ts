/**
 * 子代理是否留在状态栏 / 任务面板。
 *
 * 正常完成的收起（结果已经回给模型）；被我们自己收尾的也不留——模型调 kill、
 * 上一轮正常结束后统一收尾一批后台子代理，这些都在对话里交代过了。
 * 只有「被打断、还能接着做」的留下：点停止、宿主关闭、上一轮以中止收尾，
 * 记录带 `interrupted`，可以看最近活动、可以重启；失败与未完成同样需要人看一眼。
 */
export function keepsSubagentTaskRow(task: { status: string; interrupted?: boolean }): boolean {
  if (task.status === 'running') return true;
  if (task.status === 'completed') return false;
  if (task.status === 'killed') return task.interrupted === true;
  return true;
}
