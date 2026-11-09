import { useEffect, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import ArcoModal from '@arco-design/web-react/es/Modal';
import '../arco-settings.css';
import { appIcons } from '../icons.js';

const modalStack: { host: HTMLDivElement | null }[] = [];

export function Modal({
  title,
  onClose,
  children,
  wide = false,
  portal = false,
}: {
  title: ReactNode;
  onClose(): void;
  children: ReactNode;
  wide?: boolean;
  portal?: boolean;
}) {
  const CloseIcon = appIcons.close;
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const cardRef = useRef<HTMLDivElement>(null);
  const hostRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const entry = { host: hostRef.current };
    const descendantIndex = modalStack.findIndex(
      (modal) => modal.host !== entry.host && entry.host?.contains(modal.host),
    );
    if (descendantIndex < 0) modalStack.push(entry);
    else modalStack.splice(descendantIndex, 0, entry);
    const previousFocus = document.activeElement;
    if (portal) cardRef.current?.querySelector<HTMLButtonElement>('.modal-close')?.focus();
    const closeOnEscape = (event: KeyboardEvent) => {
      if (modalStack[modalStack.length - 1] !== entry) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopImmediatePropagation();
        closeRef.current();
      }
      if (portal && event.key === 'Tab') {
        const controls = cardRef.current?.querySelectorAll<HTMLElement>(
          'button:not(:disabled), a[href], input:not(:disabled), textarea:not(:disabled), [tabindex="0"]',
        );
        const first = controls?.[0];
        const last = controls?.[controls.length - 1];
        if (
          first &&
          last &&
          (!cardRef.current?.contains(document.activeElement) ||
            (event.shiftKey ? document.activeElement === first : document.activeElement === last))
        ) {
          event.preventDefault();
          (event.shiftKey ? last : first).focus();
        }
      }
    };
    window.addEventListener('keydown', closeOnEscape, true);
    return () => {
      window.removeEventListener('keydown', closeOnEscape, true);
      modalStack.splice(modalStack.indexOf(entry), 1);
      if (portal && previousFocus instanceof HTMLElement && previousFocus.isConnected) previousFocus.focus();
    };
  }, [portal]);

  const content = (
    <div ref={hostRef} className={portal ? 'mica-config-ui is-embed modal-portal' : 'modal-anchor'}>
      <ArcoModal
        visible
        title={title}
        footer={null}
        className={`modal-card modal-arco${wide ? ' modal-card-wide' : ''}`}
        style={{ width: wide ? 880 : 680, maxWidth: 'calc(100% - 48px)' }}
        wrapClassName="modal-arco-backdrop"
        escToExit={false}
        focusLock={false}
        autoFocus={false}
        getPopupContainer={() => hostRef.current!}
        getChildrenPopupContainer={(node) => node.closest('.mica-config-ui') ?? node.parentElement ?? node}
        onCancel={onClose}
        afterOpen={() => {
          if (portal) cardRef.current?.querySelector<HTMLButtonElement>('.modal-close')?.focus();
        }}
        closeIcon={
          <button type="button" className="modal-close" aria-label="关闭">
            <CloseIcon size={15} aria-hidden="true" />
          </button>
        }
        modalRender={(modal) => (
          <div ref={cardRef} className="modal-arco-content" data-mica-config-modal>
            {modal}
          </div>
        )}
      >
        <div className="modal-body">{children}</div>
      </ArcoModal>
    </div>
  );
  return portal ? createPortal(content, document.body) : content;
}
