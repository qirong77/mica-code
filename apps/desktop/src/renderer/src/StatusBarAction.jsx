import { ArcoAction } from '@mica-config-ui/web'

/** 底栏文字保留点击动作；拖选文字时不打开分支/目录选择器。 */
export function StatusBarAction({ className = '', onClick, ...props }) {
  return (
    <ArcoAction
      {...props}
      className={`statusbar-text-action ${className}`}
      onClick={(event) => {
        const selection = event.currentTarget.ownerDocument.defaultView?.getSelection()
        if (
          event.detail > 0 &&
          selection &&
          !selection.isCollapsed &&
          selection.containsNode(event.currentTarget, true)
        ) {
          return
        }
        onClick?.(event)
      }}
    />
  )
}
