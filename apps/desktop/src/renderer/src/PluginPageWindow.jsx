import { useEffect, useState } from 'react'
import { loadPluginPageEntry } from './plugin-entries'
import { PluginPage } from './PluginPage'
import { readPluginsDetails } from './plugins-details'
import { matchesPluginPagePath } from '@packages/mica-web-shared/app-paths.js'

/**
 * 独立打开的插件整页（`/plugins/pages/<插件 id>`）。
 *
 * 页面产物只有一份：应用里点开插件页、浏览器里打开这个地址、手机上（口令对了之后）
 * 打开这个地址，画的都是同一个 `desktop.jsx` 组件、读同一份插件数据。区别只在这层壳：
 * 这里没有会话、没有侧栏，关掉页面就是回到应用根地址。
 */
export default function PluginPageWindow({ pluginId }) {
  const [entry, setEntry] = useState(null)
  const [state, setState] = useState('loading')

  useEffect(() => {
    let alive = true
    setState('loading')
    void readPluginsDetails()
      .then((plugins) => {
        const plugin = plugins.find((item) => item?.id === pluginId)
        if (plugin?.state !== 'enabled' || !plugin.desktopPage ||
          !matchesPluginPagePath(window.location.pathname, pluginId, plugin.desktopPage.route)) return null
        return loadPluginPageEntry(pluginId)
      })
      .then((loaded) => {
        if (!alive) return
        if (!loaded) {
          setState('missing')
          return
        }
        setEntry(loaded)
        setState('ready')
      })
      .catch(() => {
        if (alive) setState('missing')
      })
    return () => {
      alive = false
    }
  }, [pluginId])

  if (state === 'ready' && entry) {
    return <PluginPage entry={entry} standalone onClose={() => window.location.assign('/')} />
  }

  return (
    <div className="grid h-full place-items-center bg-canvas px-6">
      <div className="max-w-sm text-center">
        <p className="text-sm font-medium text-fg-strong">
          {state === 'loading' ? '正在打开…' : '这个插件页面打不开'}
        </p>
        {state === 'missing' && (
          <>
            <p className="mt-2 text-xs leading-relaxed text-fg-muted">
              插件 <span className="font-mono">{pluginId}</span> 可能已停用、没有整页，或者当前这版
              产物里没有它的页面模块。
            </p>
            <button
              type="button"
              className="mt-4 text-xs text-accent hover:underline"
              onClick={() => window.location.assign('/')}
            >
              打开 Mica
            </button>
          </>
        )}
      </div>
    </div>
  )
}
