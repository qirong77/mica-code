import { forwardRef, type ButtonHTMLAttributes, type ComponentProps, type ReactNode } from 'react';
import ConfigProvider from '@arco-design/web-react/es/ConfigProvider';
import ArcoButton from '@arco-design/web-react/es/Button';
import zhCN from '@arco-design/web-react/es/locale/zh-CN';
import '../arco-settings.css';

export { default as Button } from '@arco-design/web-react/es/Button';
export { default as Input } from '@arco-design/web-react/es/Input';
export { default as InputNumber } from '@arco-design/web-react/es/InputNumber';
export { default as Radio } from '@arco-design/web-react/es/Radio';
export { default as Select } from '@arco-design/web-react/es/Select';
export { default as Tag } from '@arco-design/web-react/es/Tag';
export { default as ArcoPopover } from '@arco-design/web-react/es/Popover';

type ArcoActionProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  [key: `data-${string}`]: string | number | boolean | undefined;
  appearance?: 'text' | 'secondary' | 'primary' | 'outline';
  tone?: 'accent' | 'danger' | 'success' | 'warning';
  iconOnly?: boolean;
};

export const ArcoAction = forwardRef<HTMLButtonElement, ArcoActionProps>(function ArcoAction(
  { type = 'button', className = '', appearance = 'text', tone, children, onClick, ...props },
  ref,
) {
  return (
    <ArcoButton
      {...props}
      ref={ref}
      htmlType={type}
      type={appearance === 'text' && props['aria-pressed'] === true ? 'secondary' : appearance}
      status={tone === 'accent' ? undefined : tone}
      // Arco types this as DOM Event but forwards React's mouse event unchanged.
      onClick={onClick as ComponentProps<typeof ArcoButton>['onClick']}
      size="small"
      className={`mica-arco-action${tone === 'accent' ? ' mica-arco-action-accent' : ''} ${className}`.trim()}
    >
      {children}
    </ArcoButton>
  );
});

export function arcoPopupContainer(node?: HTMLElement): Element {
  if (!node) return document.body;
  return node.closest('.mica-config-ui') ?? document.body;
}

export function ArcoProvider({ children }: { children: ReactNode }) {
  return (
    <ConfigProvider size="small" locale={zhCN} autoInsertSpaceInButton={false} getPopupContainer={arcoPopupContainer}>
      {children}
    </ConfigProvider>
  );
}

export function ArcoSettings({ children }: { children: ReactNode }) {
  return (
    <div className="arco-settings">
      <ArcoProvider>{children}</ArcoProvider>
    </div>
  );
}
