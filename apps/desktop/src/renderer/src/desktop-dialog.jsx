import { useSyncExternalStore } from 'react'
import { Button } from '@mica-config-ui/web'
import { createDialogStore } from '../../../../../packages/mica-config-ui/web/components/dialogState'
import { ModalShell } from './chat-modal'

export const desktopDialogStore = createDialogStore()

export function confirmAction(message) {
  return desktopDialogStore.confirm({ title: '请确认', message, danger: true })
}

export async function alertAction(message) {
  await desktopDialogStore.confirm({ title: '提示', message, confirmText: '确定', cancelText: '' })
}

export function DesktopDialogHost() {
  const request = useSyncExternalStore(desktopDialogStore.subscribe, desktopDialogStore.getSnapshot)
  if (!request) return null
  const cancel = () => desktopDialogStore.settle(false)
  const alert = request.cancelText === ''
  return (
    <ModalShell
      key={request.id}
      title={request.title}
      onClose={cancel}
      className="chat-modal-prompt"
      footer={
        <>
          {!alert && <Button autoFocus={request.danger} onClick={cancel}>{request.cancelText ?? '取消'}</Button>}
          <Button autoFocus={!request.danger} variant={request.danger ? 'danger' : 'primary'} onClick={() => desktopDialogStore.settle(true)}>
            {request.confirmText ?? '确定'}
          </Button>
        </>
      }
    >
      <div style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{request.message}</div>
    </ModalShell>
  )
}
