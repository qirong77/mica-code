import { useEffect, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { appIcons } from '../icons.js';

const modalStack: object[] = [];

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

  useEffect(() => {
    const entry = {};
    modalStack.push(entry);
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
    <div
      data-mica-config-modal
      className="modal-backdrop"
      onClick={(event) => event.target === event.currentTarget && onClose()}
    >
      <div
        ref={cardRef}
        className={`modal-card${wide ? ' modal-card-wide' : ''}`}
        role="dialog"
        aria-modal="true"
        aria-label={typeof title === 'string' ? title : undefined}
      >
        <header className="modal-header">
          <div className="modal-title">{title}</div>
          <button type="button" className="modal-close" aria-label="关闭" onClick={onClose}>
            <CloseIcon size={15} aria-hidden="true" />
          </button>
        </header>
        <div className="modal-body">{children}</div>
      </div>
    </div>
  );

  return portal
    ? createPortal(<div className="mica-config-ui is-embed modal-portal">{content}</div>, document.body)
    : content;
}
