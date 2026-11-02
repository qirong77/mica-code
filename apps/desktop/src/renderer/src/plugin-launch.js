/**
 * 插件要求「在一个新会话里跑这段提示词」时的交接处。
 *
 * 面板动作的回包只能带数据（`newSession`），真正建会话、挂角色、发消息都在页面里。
 * 新会话是**另一个 ChatView 实例**（按 nodeId 挂载），而动作发生在旧实例上，所以中间
 * 需要一份按 nodeId 记的交接单：旧实例建好节点后写一张，新实例挂载并读完历史后取走。
 *
 * 也可能根本没有新实例：`createTerminal` 会复用已有的空草稿，那时目标就是**当前已经挂着**
 * 的那个 ChatView。它不会因为「被选中」重新挂载，所以交接单写完还要通知一声，让已经在场的
 * 实例立刻来取——靠订阅而不是靠轮询，是因为这条路径必须点完就有反应。
 *
 * 存在模块里而不是 ui-state：这条任务只对「这一次会话进程内的这一次跳转」有效，刷新页面
 * 就应当作废——重启后凭空发一条消息比丢掉它更糟。
 */

const pending = new Map()
const listeners = new Set()

/** 记下「这个节点一挂载就跑这段」。同一个节点再写一次会覆盖上一条。 */
export function queuePluginLaunch(nodeId, task) {
  const prompt = typeof task?.prompt === 'string' ? task.prompt.trim() : ''
  if (!nodeId || !prompt) return false
  pending.set(nodeId, {
    prompt,
    role: task.role || '',
    // 只有显式 `false` 才是「只放进输入框」：认不出的一律按发送处理，那是插件的默认语义。
    send: task.send !== false
  })
  // 通知只是「顺便」：某个在场的视图取单失败，不能连累发单方（它还等着关掉配置页）。
  for (const listener of listeners) {
    try {
      listener(nodeId)
    } catch {
      // 交接单已经记下了，取单失败的那一处下次挂载还会再试
    }
  }
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

/**
 * 订阅「有新的交接单了」。
 *
 * 监听者只关心是不是自己那个节点——别处开的会话由它自己的实例在挂载时取走。
 */
export function subscribePluginLaunch(listener) {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
