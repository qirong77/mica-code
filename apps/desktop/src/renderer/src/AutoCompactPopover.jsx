import { useEffect, useRef, useState } from 'react'
import { IconAlertCircle, IconSettings } from '@tabler/icons-react'
import { Popover } from './Popover'
import {
  DEFAULT_AUTO_COMPACT_SETTINGS,
  autoCompactDraftFromSettings,
  autoCompactRunLabel,
  autoCompactSettingsFromDraft
} from './auto-compact'

/**
 * 输入框右侧齿轮图标的面板：自动压缩（快速 / 模型两条规则）。
 *
 * 规则与按会话记账的计数都在运行时里（`src/host/auto-compact.js`），这里只是它的表单：
 * 保存把整份设置写回去（失败留在面板上并把原因写进错误行），重置只清当前会话的计数。
 *
 * 浮层外壳（尺寸、关闭时机）在 `Popover.jsx`，与模型选择、定时任务共用同一套。
 */
export function AutoCompactPopover({ settings, counters, onSave, onResetCounters, onClose }) {
  const active = settings && typeof settings === 'object' ? settings : DEFAULT_AUTO_COMPACT_SETTINGS
  const draft = autoCompactDraftFromSettings(active)
  const draftKey = JSON.stringify(draft)
  const [form, setForm] = useState(draft)
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  const appliedRef = useRef(draftKey)

  // 只在设置**值**真的变了时才回填草稿：广播每跑一轮都会带一份新的 settings 对象进来，
  // 按对象身份回填会把用户正在敲的阈值拽回旧值。
  useEffect(() => {
    if (appliedRef.current === draftKey) return
    appliedRef.current = draftKey
    setForm(draft)
  }, [draft, draftKey])

  const setField = (key) => (event) => {
    setForm((previous) => ({ ...previous, [key]: event.target.value.replace(/[^\d]/g, '') }))
    setError('')
  }

  const submit = async () => {
    const parsed = autoCompactSettingsFromDraft(form)
    if (!parsed.ok) {
      setError(parsed.error)
      return
    }
    setError('')
    setSaving(true)
    try {
      const result = await onSave?.(parsed.settings)
      if (result && result.ok === false) {
        setError(result.error || '保存失败')
        return
      }
      onClose?.()
    } catch (failure) {
      setError(String(failure?.message || failure))
    } finally {
      setSaving(false)
    }
  }

  const reset = async () => {
    setError('')
    try {
      const result = await onResetCounters?.()
      if (result && result.ok === false) setError(result.error || '重置计数失败')
    } catch (failure) {
      setError(String(failure?.message || failure))
    }
  }

  const enabled = form.enabled !== false

  return (
    <Popover
      name="auto-compact"
      title="自动压缩"
      icon={<IconSettings size={13} />}
      onClose={onClose}
      meta={enabled ? `已运行 ${autoCompactRunLabel(counters, active)}` : '已关闭'}
      headerExtra={
        <label
          className="chat-auto-compact-toggle"
          title={enabled ? '关闭自动压缩' : '开启自动压缩'}
        >
          <input
            type="checkbox"
            role="switch"
            checked={enabled}
            aria-label="启用自动压缩"
            onChange={(event) => {
              setForm((previous) => ({ ...previous, enabled: event.target.checked }))
              setError('')
            }}
          />
        </label>
      }
      actions={
        <>
          <button type="button" className="chat-auto-compact-reset" onClick={reset}>
            重置计数
          </button>
          <button
            type="button"
            className="chat-auto-compact-save"
            disabled={saving}
            onClick={submit}
          >
            保存
          </button>
        </>
      }
    >
      <div className="chat-auto-compact-rows">
        <div className="chat-auto-compact-row">
          <span className="chat-auto-compact-kind">快速压缩</span>
          <label className="chat-auto-compact-field">
            阈值
            <input
              value={form.quickThresholdK}
              inputMode="numeric"
              pattern="[0-9]*"
              aria-label="快速压缩阈值（单位 k）"
              onChange={setField('quickThresholdK')}
            />
            k
          </label>
          <label className="chat-auto-compact-field">
            上限
            <input
              value={form.quickLimit}
              inputMode="numeric"
              pattern="[0-9]*"
              aria-label="快速压缩上限（次）"
              onChange={setField('quickLimit')}
            />
            次
          </label>
          <span className="chat-auto-compact-count">
            已运行 {Number(counters?.quickRuns) || 0} 次
          </span>
        </div>

        <div className="chat-auto-compact-row">
          <span className="chat-auto-compact-kind">模型压缩</span>
          <label className="chat-auto-compact-field">
            阈值
            <input
              value={form.modelThresholdK}
              inputMode="numeric"
              pattern="[0-9]*"
              aria-label="模型压缩阈值（单位 k）"
              onChange={setField('modelThresholdK')}
            />
            k
          </label>
          <label className="chat-auto-compact-field">
            上限
            <input
              value={form.modelLimit}
              inputMode="numeric"
              pattern="[0-9]*"
              aria-label="模型压缩上限（次）"
              onChange={setField('modelLimit')}
            />
            次
          </label>
          <span className="chat-auto-compact-count">
            已运行 {Number(counters?.modelRuns) || 0} 次
          </span>
        </div>

        {/* 两个阈值才读得通的前提是「快速压缩总是先跑」这个次序：模型阈值比快速阈值更低，
            是因为 ctx 只到模型阈值时也要先本地清理一遍，而不是跳过它直接花模型请求。 */}
        <p className="chat-auto-compact-note">
          快速压缩是本地清理（不调用模型），且总是先跑：超过它的阈值时单独清一次；只超过模型阈值时
          也先清一次，清完仍高于模型阈值才升级为模型压缩（LLM 摘要）。
        </p>
      </div>

      {error ? (
        <p className="chat-auto-compact-error">
          <IconAlertCircle size={11} /> {error}
        </p>
      ) : (
        <p className="chat-auto-compact-hint">
          每完成一次模型请求即检查一次 ctx；超过阈值就自动压缩，不等整个任务结束。
        </p>
      )}
    </Popover>
  )
}
