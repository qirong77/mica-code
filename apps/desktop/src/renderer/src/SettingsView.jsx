import { useEffect, useState } from 'react'
import { ConfigWebApp, setConfigWebClient, setConfigWebEditor } from '@mica-config-ui/web'
import { createDesktopConfigWebClient } from './config-web'
import { LocalJsonEditor } from './config-web-editor'

// 宿主接线只做一次：数据源走运行时 IPC、编辑器用应用自带的 monaco；页面组件本身来自
// packages/mica-config-ui（浏览器端 apps/config-web 用同一份源码，见那里的 main.tsx）。
setConfigWebClient(createDesktopConfigWebClient())
setConfigWebEditor(LocalJsonEditor)

/**
 * Settings 视图：直接渲染配置页组件。
 *
 * 数据来自页面所连的那台运行时，所以「切到另一台服务器」之后这个视图改的就是那台的
 * 配置——不再依赖本机拉起 config-web 子进程，也没有跨源 iframe。
 */
export function SettingsView({ visible }) {
  // 首次打开才挂载，之后保持挂载以保留页内状态（与其它视图的常驻方式一致）
  const [mounted, setMounted] = useState(visible)
  useEffect(() => {
    if (visible) setMounted(true)
  }, [visible])

  return (
    <section
      className={`min-h-0 flex-1 flex-col overflow-hidden ${visible ? 'flex' : 'hidden'}`}
      aria-hidden={!visible}
    >
      {mounted ? <ConfigWebApp /> : null}
    </section>
  )
}
