import { useCallback, useEffect, useState } from 'react'
import { PluginSettingInput, SettingRow, SettingsGroup } from '@mica-config-ui/web'

/**
 * 会话设置里的「插件」一节。
 *
 * 只渲染清单里标了 `perSession` 的字段——那是插件自己声明「这一项按会话走」，
 * 内核不认识任何具体插件。默认值仍归插件设置（配置页）管，这里改动只作用于当前
 * 会话，并随会话快照落盘。
 *
 * 每个字段默认「跟随默认值」，改过之后出现「跟随默认」按钮把它退回继承状态：
 * 只存改过的键，所以之后调默认值时，没动过的字段会跟着变。
 */
export function PluginSettingsPanel({ nodeId, sessionId, cwd, running }) {
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
    void load()
  }, [load])

  // `null` 是「退回跟随默认值」，空字符串是用户真的把这一项清空了：两者不能混，
  // 否则把数字清空会被当成没改过。
  const apply = useCallback(
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

  if (plugins === null) {
    return <p className="capability-note">{error || '正在加载…'}</p>
  }

  if (plugins.length === 0) {
    return (
      <p className="capability-note">
        没有可按会话调整的插件设置。插件在清单里给设置项标上 <code>perSession</code>
        之后会出现在这里。
      </p>
    )
  }

  return (
    <div className="session-plugin-settings">
      {plugins.map((plugin) => (
        <SettingsGroup key={plugin.id} title={plugin.name} description={plugin.description || ''}>
          {plugin.fields.map((field) => {
            const overridden = Object.prototype.hasOwnProperty.call(
              plugin.overrides ?? {},
              field.key
            )
            const value =
              typeof plugin.values?.[field.key] === 'string' ? plugin.values[field.key] : ''
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
                    onChange={(next) => void apply(plugin.id, field.key, next)}
                  />
                  {overridden ? (
                    <button
                      type="button"
                      className="session-plugin-reset"
                      disabled={running || saving}
                      onClick={() => void apply(plugin.id, field.key, null)}
                    >
                      跟随默认
                    </button>
                  ) : null}
                </div>
              </SettingRow>
            )
          })}
        </SettingsGroup>
      ))}
      {error ? <p className="session-settings-error">{error}</p> : null}
    </div>
  )
}

function formatError(error) {
  if (error instanceof Error) return error.message
  return String(error || '未知错误')
}
