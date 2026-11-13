// 编辑器（应用自带的 monaco）与数据源都在渲染层入口（main.jsx）注册过一次：会话详情、
// 插件卡片也会在设置页之外打开，跟着设置页懒加载会晚一拍。
import { ConfigWebApp } from '@mica-config-ui/web'
import { useMemo } from 'react'

/**
 * 设置 / 插件页：整页打开的配置页。
 *
 * 桌面上它盖住整个窗口（包括左侧会话列表），而不是塞进对话区右侧：配置页自带一列导航，
 * 再套一层会话列表只会把内容挤窄；顶部「返回对话」把用户送回对话，设置因此是一层页面，
 * 而不是一个可以一直开着的面板。
 *
 * 数据来自页面所连的那台运行时，所以「切到另一台服务器」之后这里改的就是那台的配置——
 * 不依赖本机拉起 config-web 子进程，也没有跨源 iframe。
 *
 * 每次打开都重新挂载（`key` 含 section / 插件 id）：入口决定了落在哪一页，残留的上一页
 * 导航状态会让人以为点错了地方（例如从插件菜单进却停在上次的 Performance）。
 */
export function SettingsView({
  section = 'config',
  pluginId = null,
  actionCwd,
  capabilityTarget,
  onClose,
  onNewSession,
  onOpenPluginPage
}) {
  const targetId = capabilityTarget?.id
  const targetSessionId = capabilityTarget?.sessionId
  const capabilitiesRuntime = useMemo(
    () =>
      targetId
        ? {
            key: `${targetId}:${targetSessionId ?? ''}:${actionCwd ?? ''}`,
            read: async () => {
              const result = await window.mica.chat.capabilities(targetId, {
                sessionId: targetSessionId,
                cwd: actionCwd
              })
              if (!result?.ok) throw new Error(result?.error || '读取会话能力失败')
              return result
            },
            setSelection: async (selection) => {
              const result = await window.mica.chat.setCapabilities(targetId, selection, {
                sessionId: targetSessionId,
                cwd: actionCwd
              })
              if (!result?.ok) throw new Error(result?.error || '更新会话能力失败')
              return result
            }
          }
        : undefined,
    [targetId, targetSessionId, actionCwd]
  )
  return (
    <section className="mica-config-shell" aria-label="Mica 设置">
      <ConfigWebApp
        key={`${section}:${pluginId ?? ''}`}
        initialSection={section}
        initialPluginId={pluginId}
        actionCwd={actionCwd}
        capabilitiesRuntime={capabilitiesRuntime}
        onClose={onClose}
        closeLabel="返回对话"
        onNewSession={onNewSession}
        onOpenPluginPage={onOpenPluginPage}
      />
    </section>
  )
}
