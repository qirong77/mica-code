/** Desktop import boundary; all hosts share the public plugin JSON storage implementation. */
export {
  PLUGIN_DATA_MAX_BYTES,
  PLUGIN_DOCUMENT_MAX_BYTES,
  PLUGIN_DATA_FILE,
  isValidPluginId,
  isValidPluginDocumentKey,
  pluginDataPath,
  encodePluginData,
  decodePluginData
} from '@packages/mica-plugin/PluginData.js'
