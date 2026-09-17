import { useEffect, type ReactNode } from 'react';
import { appIcons } from '../icons.js';

export function Modal({
  title,
  onClose,
  children,
  wide = false,
}: {
  title: ReactNode;
  onClose(): void;
  children: ReactNode;
  wide?: boolean;
}) {
  const CloseIcon = appIcons.close;

  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', closeOnEscape);
    return () => document.removeEventListener('keydown', closeOnEscape);
  }, [onClose]);

  return (
    <div className="modal-backdrop" onClick={(event) => event.target === event.currentTarget && onClose()}>
      <div className={`modal-card${wide ? ' modal-card-wide' : ''}`} role="dialog" aria-modal="true">
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
}
