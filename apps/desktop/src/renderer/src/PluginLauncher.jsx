import { useEffect, useMemo, useState } from 'react'
import { Button } from '@mica-config-ui/web'
import { createPluginHostApi } from './plugin-host'
import { pluginEntryLoader } from './plugin-entries'
import { readPluginsDetails } from './plugins-details'

/** Small standalone renderer for a manifest-declared launcher; never mounts a chat. */
export function PluginLauncher({ pluginId }) {
  const api = useMemo(() => createPluginHostApi(pluginId), [pluginId])
  const [state, setState] = useState({ Component: null, error: '' })
  useEffect(() => {
    let alive = true
    Promise.resolve()
      .then(async () => {
        const plugin = (await readPluginsDetails({ force: true })).find(
          (item) => item.id === pluginId
        )
        if (plugin?.state !== 'enabled' || !plugin.desktopLauncher)
          throw new Error('插件已停用或没有桌面启动器')
        const load = pluginEntryLoader(pluginId)
        const module = load ? await load() : null
        if (!module?.Launcher) throw new Error('插件没有提供启动器界面')
        if (alive) setState({ Component: module.Launcher, error: '' })
      })
      .catch((error) => {
        if (alive) setState({ Component: null, error: error.message })
      })
    return () => {
      alive = false
    }
  }, [pluginId])
  return (
    <div className="mica-config-ui h-full bg-canvas text-fg">
      {state.Component ? (
        <state.Component api={api} />
      ) : (
        <div
          className="flex h-full flex-col items-center justify-center gap-3 p-6 text-sm"
          role="status"
        >
          {state.error || '正在打开…'}
          {state.error && (
            <Button size="compact" onClick={() => window.location.reload()}>
              重试
            </Button>
          )}
        </div>
      )}
    </div>
  )
}
