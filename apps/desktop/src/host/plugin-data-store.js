/** Keep desktop callers on the same CAS, process lock and atomic write rules as headless. */
import { readPluginData } from '@packages/mica-plugin/PluginData.js'

export { readPluginData }
export { readPluginDataVersion, writePluginData } from '@packages/mica-plugin/PluginData.js'

/** A page may omit a document body only after validating these exact file bytes. */
export function readPagePluginData(home, pluginId, options, ifVersion) {
  const result = readPluginData(home, pluginId, options)
  return Object.hasOwn(options, 'key') && result.version !== null && result.version === ifVersion
    ? { unchanged: true, version: result.version }
    : result
}
