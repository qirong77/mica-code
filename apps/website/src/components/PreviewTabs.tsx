import { cloneElement, isValidElement, useState } from 'react';
import type { HTMLAttributes, KeyboardEvent, ReactElement } from 'react';
import TabsModule from '@arco-design/web-react/lib/Tabs/index.js';
import '@arco-design/web-react/es/Tabs/style/index.css';
import SiteIcon from './SiteIcon';

const previews = ['workspace', 'trace'] as const;
type Preview = (typeof previews)[number];

// Arco's CommonJS entry supports Node SSR as well as Vite's browser interop.
const Tabs = (TabsModule as unknown as { default?: typeof TabsModule }).default ?? TabsModule;

export default function PreviewTabs() {
  const [active, setActive] = useState<Preview>('workspace');

  const selectPreview = (preview: Preview) => {
    setActive(preview);
    // The panels remain Astro-rendered so the preview and its semantics exist without JS.
    previews.forEach((item) => {
      const panel = document.getElementById(`preview-${item}`);
      if (panel) panel.hidden = item !== preview;
    });
  };

  const onTabKeyDown = (event: KeyboardEvent<HTMLDivElement>, preview: Preview) => {
    const index = previews.indexOf(preview);
    let next: Preview;
    switch (event.key) {
      case 'ArrowLeft':
        next = previews[(index + previews.length - 1) % previews.length];
        break;
      case 'ArrowRight':
        next = previews[(index + 1) % previews.length];
        break;
      case 'Home':
        next = previews[0];
        break;
      case 'End':
        next = previews[previews.length - 1];
        break;
      case 'Enter':
      case ' ':
        next = preview;
        break;
      default:
        return;
    }
    event.preventDefault();
    selectPreview(next);
    document.getElementById(`tab-${next}`)?.focus();
  };

  return (
    <Tabs
      className="preview-tabs"
      type="rounded"
      activeTab={active}
      onChange={(key) => selectPreview(key as Preview)}
      renderTabHeader={(props, Header) => (
        <div role="tablist" aria-label="工作区预览">
          <Header {...props} />
        </div>
      )}
      renderTabTitle={(title, info) => {
        if (!isValidElement(title)) return title;
        const preview = info.key as Preview;
        // Arco assigns IDs only after mounting and makes every tab tabbable.
        return cloneElement(title as ReactElement<HTMLAttributes<HTMLDivElement>>, {
          id: `tab-${preview}`,
          'aria-controls': `preview-${preview}`,
          tabIndex: info.isActive ? 0 : -1,
          onKeyDown: (event) => onTabKeyDown(event, preview),
        });
      }}
    >
      <Tabs.TabPane
        key="workspace"
        title={
          <>
            <SiteIcon name="monitor" size={15} /> 工作区
          </>
        }
      />
      <Tabs.TabPane
        key="trace"
        title={
          <>
            <SiteIcon name="terminal" size={15} /> 执行过程
          </>
        }
      />
    </Tabs>
  );
}
