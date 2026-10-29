/**
 * 插件要求「在一个新会话里跑这段提示词」时的交接处。
 *
 * 面板动作的回包只能带数据（`newSession`），真正建会话、挂角色、发消息都在页面里。
 * 新会话是**另一个 ChatView 实例**（按 nodeId 挂载），而动作发生在旧实例上，所以中间
 * 需要一份按 nodeId 记的交接单：旧实例建好节点后写一张，新实例挂载并读完历史后取走。
 *
 * 存在模块里而不是 ui-state：这条任务只对「这一次会话进程内的这一次跳转」有效，刷新页面
 * 就应当作废——重启后凭空发一条消息比丢掉它更糟。
 */

const pending = new Map()

/** 记下「这个节点一挂载就跑这段」。同一个节点再写一次会覆盖上一条。 */
export function queuePluginLaunch(nodeId, task) {
  const prompt = typeof task?.prompt === 'string' ? task.prompt.trim() : ''
  if (!nodeId || !prompt) return false
  pending.set(nodeId, { prompt, role: task.role || '' })
  return true
}

/** 取走并清掉（一次性：同一个节点不会因为重渲染把同一条消息发两遍）。 */
export function takePluginLaunch(nodeId) {
  if (!nodeId) return null
  const task = pending.get(nodeId)
  if (!task) return null
  pending.delete(nodeId)
  return task
}
