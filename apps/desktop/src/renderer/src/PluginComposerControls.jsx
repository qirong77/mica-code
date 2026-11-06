import { Suspense, useMemo } from 'react'
import { usePluginsDetails } from './plugins-details'
import { pluginEntryLoader } from './plugin-entries'
import { createPluginHostApi } from './plugin-host'
import { lazyView } from './lazy-view'

const controls = new Map()

function composerView(pluginId) {
  if (!controls.has(pluginId)) {
    const load = pluginEntryLoader(pluginId)
    if (!load) return null
    controls.set(pluginId, lazyView(load, 'Composer'))
  }
  return controls.get(pluginId)
}

function ComposerControl({ pluginId, session, ...props }) {
  const api = useMemo(
    () => createPluginHostApi(pluginId, session),
    [pluginId, session.id, session.sessionId, session.cwd]
  )
  const View = composerView(pluginId)
  // 动作区只有 30px 高：槽位只负责「能收窄」，控件自己的排版与文案宽度由插件决定。
  return View ? (
    <Suspense fallback={null}>
      <div className="flex min-w-0 items-center">
        <View api={api} {...props} />
      </div>
    </Suspense>
  ) : null
}

/** Plugins own controls; the host owns session identity and draft edits. */
export function PluginComposerControls({ session, visible, onOpenPluginSettings, ...props }) {
  const plugins = usePluginsDetails()
  if (!visible || !session?.id) return null
  return plugins
    .filter((plugin) => plugin.state === 'enabled' && plugin.desktopComposer === true)
    .map((plugin) => (
      <ComposerControl
        key={`${plugin.id}:${session.id}:${session.sessionId || ''}`}
        pluginId={plugin.id}
        session={session}
        visible={visible}
        onOpenSettings={() => onOpenPluginSettings?.(plugin.id)}
        {...props}
      />
    ))
}
