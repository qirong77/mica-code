import { useCallback, useEffect, useState } from 'react'
import {
  LlmSettingsSection,
  PluginSettingInput,
  SettingRow,
  SettingsGroup
} from '@mica-config-ui/web'

/**
 * 会话设置里的「插件」一节。
 *
 * 只渲染清单里标了 `perSession` 的字段——那是插件自己声明「这一项按会话走」，
 * 内核不认识任何具体插件。默认值仍归插件设置（配置页）管，这里改动只作用于当前
 * 会话，并随会话快照落盘。
 *
 * **哪个插件**由左侧导航决定（见 SessionSettingsDialog），这里只画选中的那一个：
 * 内容区不再出现页签，插件列表与「会话能力 / 定时任务」在同一个导航里，用户不需要
 * 在两处找入口。
 *
 * 每个字段默认「跟随默认值」，改过之后出现「跟随默认」按钮把它退回继承状态：
 * 只存改过的键，所以之后调默认值时，没动过的字段会跟着变。
 */

/**
 * 读一份「哪些插件有会话级设置」。`enabled` 为假时不发请求：用户没点开插件一节之前，
 * 这条 host 调用没有意义。
 */
export function usePluginSessionSettings({ nodeId, sessionId, cwd, enabled }) {
  const [plugins, setPlugins] = useState(null)
  const [error, setError] = useState('')
  const [savingKey, setSavingKey] = useState('')

  const load = useCallback(async () => {
    setError('')
    try {
      const result = await window.mica.chat.pluginSettings(nodeId, { sessionId, cwd })
      if (!result?.ok) {
        setError(result?.error || '读取插件设置失败')
        return
      }
      setPlugins(Array.isArray(result.plugins) ? result.plugins : [])
    } catch (loadError) {
      setError(formatError(loadError))
    }
  }, [nodeId, sessionId, cwd])

  useEffect(() => {
    if (enabled) void load()
  }, [enabled, load])

  // `null` 是「退回跟随默认值」，空字符串是用户真的把这一项清空了：两者不能混，
  // 否则把数字清空会被当成没改过。
  const save = useCallback(
    async (pluginId, key, value) => {
      setSavingKey(`${pluginId}:${key}`)
      setError('')
      try {
        const result = await window.mica.chat.setPluginSettings(nodeId, {
          sessionId,
          cwd,
          pluginId,
          values: { [key]: value }
        })
        if (!result?.ok) {
          setError(result?.error || '保存失败')
          // 失败要把界面拉回 host 里的真实状态，否则开关停在「看起来已经改了」。
          if (Array.isArray(result?.plugins)) setPlugins(result.plugins)
          else void load()
          return
        }
        setPlugins(Array.isArray(result.plugins) ? result.plugins : [])
      } catch (saveError) {
        setError(formatError(saveError))
        void load()
      } finally {
        setSavingKey('')
      }
    },
    [nodeId, sessionId, cwd, load]
  )

  return { plugins, error, savingKey, save }
}

export function PluginSettingsPanel({ plugin, running, savingKey, error, onSave, onOpenPanel }) {
  if (!plugin) {
    return <p className="capability-note">{error || '正在加载…'}</p>
  }

  // 模型接口那几项由共享组件渲染（配置页用的是同一份）：开关收起后不显示地址 / Key，
  // 这里再逐个字段画一遍就会绕开「跟随 / 独立」的判定。
  const fields = plugin.fields ?? []
  const llmFields = fields.filter((field) => field.group === 'llm')
  const usesLlmSection = Boolean(plugin.llm) && llmFields.length > 0
  const plainFields = usesLlmSection ? fields.filter((field) => field.group !== 'llm') : fields

  return (
    <div className="session-plugin-settings">
      <SettingsGroup title={plugin.name} description={plugin.description || ''}>
        {/* 面板入口放在插件自己的设置里：输入框上方不再占一排按钮，插件没有会话级
            字段时也有地方可点（有面板的插件即使 fields 为空也会出现在这一节）。 */}
        {plugin.panel ? (
          <SettingRow label={plugin.panel.label} hint="在对话右侧打开面板，可随时收起">
            <button
              type="button"
              className="session-plugin-open-panel"
              onClick={() => onOpenPanel?.(plugin.id)}
            >
              打开
            </button>
          </SettingRow>
        ) : null}
        {plainFields.map((field) => renderField({ plugin, field, running, savingKey, onSave }))}
      </SettingsGroup>
      {usesLlmSection ? (
        <LlmSettingsSection
          llm={plugin.llm}
          fields={fields}
          values={plugin.values ?? {}}
          errors={[]}
          onChange={(key, value) => void onSave(plugin.id, key, value)}
          overrides={plugin.overrides ?? {}}
          onReset={(key) => void onSave(plugin.id, key, null)}
          disabled={running}
          followLabel="当前会话模型"
        />
      ) : null}
      {error ? <p className="session-settings-error">{error}</p> : null}
    </div>
  )
}

function renderField({ plugin, field, running, savingKey, onSave }) {
  const overridden = Object.prototype.hasOwnProperty.call(plugin.overrides ?? {}, field.key)
  const value = typeof plugin.values?.[field.key] === 'string' ? plugin.values[field.key] : ''
  const saving = savingKey === `${plugin.id}:${field.key}`
  return (
    <SettingRow
      key={field.key}
      label={
        <>
          {field.label}
          {overridden ? <span className="session-plugin-tag">仅本会话</span> : null}
        </>
      }
      htmlFor={`session-plugin-setting-${plugin.id}-${field.key}`}
      wide={field.type === 'textarea'}
      // 说明讲「这一项是什么」，覆盖状态由标签与「跟随默认」按钮表达：
      // 每行都写一遍「跟随默认值」只会把有用的说明挤掉。
      hint={field.description}
    >
      <div className="session-plugin-control">
        <PluginSettingInput
          field={field}
          value={value}
          disabled={running || saving}
          invalid={false}
          onChange={(next) => void onSave(plugin.id, field.key, next)}
        />
        {overridden ? (
          <button
            type="button"
            className="session-plugin-reset"
            disabled={running || saving}
            onClick={() => void onSave(plugin.id, field.key, null)}
          >
            跟随默认
          </button>
        ) : null}
      </div>
    </SettingRow>
  )
}

function formatError(error) {
  if (error instanceof Error) return error.message
  return String(error || '未知错误')
}
