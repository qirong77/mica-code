export function createSubagentDisplay() {
  const cleared = new Set()
  const observed = new Set()
  let tasks = []
  let clearedBefore = 0

  return {
    update(snapshot) {
      tasks = (Array.isArray(snapshot) ? snapshot : []).filter((task) => {
        if (task.status === 'running') {
          cleared.delete(task.taskId)
          return true
        }
        const finishedAt = Date.parse(task.finishedAt)
        return !cleared.has(task.taskId) && !(Number.isFinite(finishedAt) && finishedAt < clearedBefore)
      })
      for (const task of tasks) observed.add(task.taskId)
      return tasks
    },
    finish(currentTurnId, completedTurnId, reason) {
      if (reason !== 'completed' || !currentTurnId || currentTurnId !== completedTurnId) return null
      clearedBefore = Math.max(clearedBefore, Date.now())
      for (const taskId of observed) cleared.add(taskId)
      observed.clear()
      tasks = []
      return tasks
    }
  }
}
