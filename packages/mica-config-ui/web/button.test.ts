import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Button } from './components/Ui.js';

describe('Button', () => {
  const noop = () => {};

  it('纯文字按钮不渲染空的图标格', () => {
    const html = renderToStaticMarkup(createElement(Button, { onClick: noop }, '取消'));
    expect(html).not.toContain('ui-button-icon');
    expect(html).toContain('<span>取消</span>');
  });

  it('有图标时保留图标格，图标按钮仍独占一格', () => {
    const withIcon = renderToStaticMarkup(createElement(Button, { icon: createElement('svg'), onClick: noop }, '刷新'));
    expect(withIcon).toContain('ui-button-icon');
    expect(withIcon).toContain('<span>刷新</span>');

    const iconOnly = renderToStaticMarkup(
      createElement(Button, { icon: createElement('svg'), title: '刷新', onClick: noop }),
    );
    expect(iconOnly).toContain('ui-button-icon-only');
  });

  it('加载态即使没有图标也要有加载格', () => {
    const html = renderToStaticMarkup(createElement(Button, { loading: true, onClick: noop }, '保存'));
    expect(html).toContain('ui-button-spinner');
  });
});
