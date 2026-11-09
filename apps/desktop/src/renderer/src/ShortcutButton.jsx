import { ArcoAction, PluginIcon } from '@mica-config-ui/web'
import { quickbarButtonLook } from './plugin-panels'

const SHORTCUT_TONES = {
  accent: 'accent',
  danger: 'danger',
  success: 'success',
  warn: 'warning'
}

export function ShortcutButton({
  shortcut,
  panelLabel = '',
  active = false,
  loading = false,
  hasMenu = Boolean(shortcut?.items || shortcut?.menu),
  badge,
  title,
  className = '',
  ...props
}) {
  const look = quickbarButtonLook(shortcut, { active, busy: loading, hasMenu, panelLabel })
  const shape = shortcut?.style?.shape
  const appearance =
    active || shape === 'soft' ? 'secondary' : shape === 'plain' ? 'text' : 'outline'

  return (
    <ArcoAction
      type="button"
      appearance={appearance}
      tone={SHORTCUT_TONES[shortcut?.style?.color]}
      iconOnly={look.iconOnly}
      title={title ?? look.title}
      aria-label={look.ariaLabel}
      aria-pressed={shortcut?.section ? active : undefined}
      aria-haspopup={hasMenu ? 'menu' : undefined}
      aria-busy={loading || undefined}
      {...props}
      className={`${look.className} ${className}`.trim()}
    >
      {look.icon && <PluginIcon name={look.icon} size={13} />}
      {!look.iconOnly && look.label}
      {loading && <span aria-label="执行中">{'\u2026'}</span>}
      {badge && <span className="chat-plugin-quickbar-badge">{badge}</span>}
      {hasMenu && (
        <span className="chat-plugin-quickbar-caret" aria-hidden="true">
          {'\u25be'}
        </span>
      )}
    </ArcoAction>
  )
}
