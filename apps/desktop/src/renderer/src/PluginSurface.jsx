import { useEffect, useRef } from 'react'
import { observePluginSurface } from './plugin-experience'

/** Mount inside Suspense so loading placeholders are not counted as content. */
export function PluginSurface({ api, surface, as: Tag = 'div', children, ...props }) {
  const element = useRef(null)
  const track = useRef(api.experience)
  track.current = api.experience
  useEffect(() => observePluginSurface(element.current, (...args) => track.current?.(...args), surface), [api.pluginId, surface])
  return <Tag ref={element} {...props}>{children}</Tag>
}
