/**
 * 桌面宿主对 `mica/subagentTasks/updated` 快照的最后一层过滤。
 *
 * 快照本身只带运行中的子代理（`mica-common/subagentVisibility.ts`），所以这里
 * 只需要钉住两件事：非运行中的条目一律不往页面推，以及一轮成功结束时把这一轮
 * 露过面的行清掉——否则收尾瞬间还挂在快照里的 `running` 行会留在 dock 里。
 */
export function createSubagentDisplay() {
  const observed = new Set()
  let tasks = []

  return {
    update(snapshot) {
      tasks = (Array.isArray(snapshot) ? snapshot : []).filter((task) => task.status === 'running')
      for (const task of tasks) observed.add(task.taskId)
      return tasks
    },
    finish(currentTurnId, completedTurnId, reason) {
      if (reason !== 'completed' || !currentTurnId || currentTurnId !== completedTurnId) return null
      observed.clear()
      tasks = []
      return tasks
    }
  }
}
