import type { ReactNode } from 'react';
import ConfigProvider from '@arco-design/web-react/es/ConfigProvider';
import '../arco-settings.css';

export { default as Button } from '@arco-design/web-react/es/Button';
export { default as Input } from '@arco-design/web-react/es/Input';
export { default as Radio } from '@arco-design/web-react/es/Radio';
export { default as Select } from '@arco-design/web-react/es/Select';
export { default as Tag } from '@arco-design/web-react/es/Tag';

export function ArcoSettings({ children }: { children: ReactNode }) {
  return (
    <div className="arco-settings">
      <ConfigProvider
        size="small"
        autoInsertSpaceInButton={false}
        getPopupContainer={(node) => node.closest('.arco-settings') as HTMLElement}
      >
        {children}
      </ConfigProvider>
    </div>
  );
}
