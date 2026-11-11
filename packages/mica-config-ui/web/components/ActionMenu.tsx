import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  type ButtonHTMLAttributes,
  type ComponentProps,
  type HTMLAttributes,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import { Button as ArcoButton } from '@arco-design/web-react';
// The host's ArcoProvider (or the editor's virtual theme) supplies the shared CSS.

export type MenuListProps = HTMLAttributes<HTMLDivElement> & {
  autoFocus?: boolean;
  onClose?: () => void;
};

export type MenuItemProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  icon?: ReactNode;
  danger?: boolean;
  selected?: boolean;
};

function enabledItems(menu: HTMLDivElement): HTMLElement[] {
  return Array.from(
    menu.querySelectorAll<HTMLElement>('[role="menuitem"], [role="menuitemcheckbox"], [role="menuitemradio"]'),
  ).filter((item) => item.closest('.mica-menu') === menu && !item.matches(':disabled, [aria-disabled="true"]'));
}

/** Menu surface and keyboard behavior; the host owns visibility and positioning. */
export const MenuList = forwardRef<HTMLDivElement, MenuListProps>(function MenuList(
  { autoFocus = false, onClose, className = '', role = 'menu', tabIndex = -1, onKeyDown, ...props },
  ref,
) {
  const menuRef = useRef<HTMLDivElement>(null);
  useImperativeHandle(ref, () => menuRef.current!, []);

  useEffect(() => {
    const menu = menuRef.current;
    if (autoFocus && menu) {
      const first =
        enabledItems(menu)[0] ?? menu.querySelector<HTMLElement>('button:not(:disabled), input:not(:disabled)');
      (first ?? menu).focus({ preventScroll: true });
    }
  }, [autoFocus]);

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    onKeyDown?.(event);
    if (event.defaultPrevented) return;

    const menu = event.currentTarget;
    const target = event.target as HTMLElement;
    if (target.closest('.mica-menu') !== menu) return;

    if (event.key === 'Escape' || event.key === 'Tab') {
      event.stopPropagation();
      if (event.key === 'Escape') event.preventDefault();
      onClose?.();
      return;
    }

    const editable = target.closest('[contenteditable]');
    if (
      target.closest('input, textarea') ||
      target.isContentEditable ||
      (editable && editable.getAttribute('contenteditable') !== 'false')
    ) {
      return;
    }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;

    const items = enabledItems(menu);
    if (!items.length) return;
    const current = items.indexOf(menu.ownerDocument.activeElement as HTMLElement);
    const next =
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? items.length - 1
          : event.key === 'ArrowDown'
            ? (current + 1) % items.length
            : (current < 0 ? items.length : current) - 1;

    event.preventDefault();
    event.stopPropagation();
    items[(next + items.length) % items.length].focus({ preventScroll: true });
  }

  return (
    <div
      {...props}
      ref={menuRef}
      role={role}
      tabIndex={tabIndex}
      className={`mica-menu ${className}`.trim()}
      onKeyDown={handleKeyDown}
    />
  );
});

export const MenuItem = forwardRef<HTMLButtonElement, MenuItemProps>(function MenuItem(
  { icon, danger = false, selected, className = '', children, onClick, ...props },
  ref,
) {
  return (
    <ArcoButton
      {...props}
      ref={ref}
      htmlType="button"
      type="text"
      size="small"
      status={danger ? 'danger' : undefined}
      role={typeof selected === 'boolean' ? 'menuitemcheckbox' : 'menuitem'}
      aria-checked={typeof selected === 'boolean' ? selected : undefined}
      className={`mica-menu-item mica-arco-row${danger ? ' is-danger' : ''} ${className}`.trim()}
      // Arco forwards React's mouse event, despite declaring a DOM Event callback.
      onClick={onClick as ComponentProps<typeof ArcoButton>['onClick']}
    >
      {icon != null && icon !== false && (
        <span className="mica-menu-icon" aria-hidden="true">
          {icon}
        </span>
      )}
      {children}
    </ArcoButton>
  );
});

export function MenuSeparator({ className = '', ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div {...props} role="separator" className={`mica-menu-separator ${className}`.trim()} />;
}
