import { useState, useSyncExternalStore } from 'react';
import { Button } from './Ui.js';
import { Modal } from './Modal.js';
import {
  createDialogStore,
  type ConfirmDialogOptions,
  type ConfirmDialogRequest,
  type PromptDialogOptions,
  type PromptDialogRequest,
} from './dialogState.js';

export const dialogStore = createDialogStore();

export function confirmDialog(options: ConfirmDialogOptions): Promise<boolean> {
  return dialogStore.confirm(options);
}

export function promptDialog(options: PromptDialogOptions): Promise<string | null> {
  return dialogStore.prompt(options);
}

/** 挂在 App 根部，渲染当前待处理的对话框（浏览器与 Electron iframe 都可用）。 */
export function DialogHost() {
  const request = useSyncExternalStore(dialogStore.subscribe, dialogStore.getSnapshot);
  if (!request) return null;
  return request.kind === 'confirm' ? (
    <ConfirmDialog key={request.id} request={request} />
  ) : (
    <PromptDialog key={request.id} request={request} />
  );
}

function ConfirmDialog({ request }: { request: ConfirmDialogRequest }) {
  const cancel = () => dialogStore.settle(false);
  return (
    <Modal title={request.title} onClose={cancel}>
      <div className="dialog-form">
        {request.message ? <p className="dialog-message">{request.message}</p> : null}
        <div className="dialog-actions">
          <Button onClick={cancel} autoFocus={request.danger}>
            {request.cancelText ?? '取消'}
          </Button>
          <Button
            variant={request.danger ? 'danger' : 'primary'}
            autoFocus={!request.danger}
            onClick={() => dialogStore.settle(true)}
          >
            {request.confirmText ?? '确定'}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

function PromptDialog({ request }: { request: PromptDialogRequest }) {
  const [value, setValue] = useState(request.initialValue ?? '');
  const canSubmit = value.trim() !== '';
  const cancel = () => dialogStore.settle(false);
  const submit = () => {
    if (canSubmit) dialogStore.settle(true, value);
  };

  return (
    <Modal title={request.title} onClose={cancel}>
      <div className="dialog-form">
        {request.message ? <p className="dialog-message">{request.message}</p> : null}
        <label className="dialog-field">
          <span>{request.label ?? '名称'}</span>
          <input
            className="text-input"
            value={value}
            placeholder={request.placeholder}
            autoFocus
            onChange={(event) => setValue(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== 'Enter') return;
              event.preventDefault();
              submit();
            }}
          />
        </label>
        <div className="dialog-actions">
          <Button onClick={cancel}>{request.cancelText ?? '取消'}</Button>
          <Button variant="primary" disabled={!canSubmit} onClick={submit}>
            {request.confirmText ?? '确定'}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
