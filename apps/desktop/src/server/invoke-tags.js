export function makeCallerTags(isConfigWebAction) {
  return function callerTags(channel, payload) {
    if (!payload || typeof payload !== 'object') return undefined
    const tags = {}
    if (channel === 'config-web:invoke' && isConfigWebAction(payload.action)) {
      tags.action = payload.action
    }
    if (typeof payload.pluginId === 'string' && payload.pluginId) tags.plugin = payload.pluginId
    // `nodeId` 是页签身份，`sessionId` 才是会话身份：两者都有时以会话为准。
    if (typeof payload.sessionId === 'string' && payload.sessionId) tags.sid = payload.sessionId
    else if (typeof payload.nodeId === 'string' && payload.nodeId) tags.node = payload.nodeId
    // 目录只看最后一段：完整路径对定位没帮助，还会把日志撑长。
    if (typeof payload.cwd === 'string' && payload.cwd) {
      tags.cwd = payload.cwd.split('/').filter(Boolean).pop()
    }
    // 渲染层自己声明「这个调用来自看不见的页面」时照实记：可见性门控有没有生效，
    // 只能靠这个字段验证。
    if (payload.hidden === true) tags.hidden = true
    return Object.keys(tags).length ? tags : undefined
  }
}
