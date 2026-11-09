import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Alert, Button, Checkbox, CollapsiblePanel, Empty, Segmented, Switch, Tag } from './components/Ui.js';

describe('Button', () => {
  const noop = () => {};

  it('纯文字按钮不渲染空的图标格', () => {
    const html = renderToStaticMarkup(createElement(Button, { onClick: noop }, '取消'));
    expect(html).toContain('arco-btn');
    expect(html).not.toContain('ui-button-icon');
    expect(html).not.toContain('<svg');
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
    expect(iconOnly).toContain('arco-btn-icon-only');
    expect(iconOnly).toContain('aria-label="刷新"');
  });

  it('span 图标和文字也保留间距，自动刷新圆点不参与文字基线布局', () => {
    const html = renderToStaticMarkup(
      createElement(Button, {
        icon: createElement('span', { className: 'perf-auto-dot perf-auto-dot-on' }),
        onClick: noop,
      }, '自动刷新'),
    );
    expect(html).toContain('ui-button-icon');
    expect(html).toContain('<span>自动刷新</span>');
    const css = readFileSync(new URL('./arco-settings.css', import.meta.url), 'utf8');
    const button = css.match(/\.arco-btn\s*\{([^}]+)\}/)?.[1];
    expect(button).toContain('display: inline-flex');
    expect(button).toContain('flex-flow: row nowrap');
    expect(button).toContain('align-items: center');
    expect(button).toContain('white-space: nowrap');
    expect(css).toMatch(/\.arco-btn > svg\s*\{\s*flex: none;/);
    const icon = css.match(/\.ui-button-icon\s*\{([^}]+)\}/)?.[1];
    expect(icon).toContain('flex: none');
    expect(css).toMatch(/\.ui-button-icon \+ span\s*\{\s*margin-left: 6px;/);
    const styles = readFileSync(new URL('./styles.css', import.meta.url), 'utf8');
    const dot = styles.match(/\.perf-auto-dot\s*\{([^}]+)\}/)?.[1];
    expect(dot).toContain('display: block');
    expect(dot).toContain('width: 7px');
    expect(dot).toContain('height: 7px');
  });

  it('加载态即使没有图标也要有加载格', () => {
    const html = renderToStaticMarkup(createElement(Button, { loading: true, onClick: noop }, '保存'));
    expect(html).toContain('arco-btn-loading');
    expect(html).toContain('arco-icon-loading');
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain('disabled=""');
    expect(html).not.toContain('ui-button-icon"');
  });

  it('保留紧凑尺寸、整行、按钮状态与显式无障碍标签', () => {
    const html = renderToStaticMarkup(
      createElement(Button, {
        onClick: noop,
        size: 'compact',
        variant: 'danger-ghost',
        fullWidth: true,
        pressed: true,
        disabled: true,
        title: 'Delete',
        ariaLabel: 'Remove entry',
        icon: createElement('svg'),
      }),
    );
    expect(html).toContain('arco-btn-size-mini');
    expect(html).toContain('ui-button-compact');
    expect(html).toContain('ui-button-full');
    expect(html).toContain('arco-btn-long');
    expect(html).toContain('arco-btn-text');
    expect(html).toContain('arco-btn-status-danger');
    expect(html).toContain('aria-pressed="true"');
    expect(html).toContain('aria-label="Remove entry"');
    expect(html).toContain('disabled=""');
  });

  it('强调操作与当前项保持不同按钮类型', () => {
    const accent = renderToStaticMarkup(createElement(Button, { onClick: noop, variant: 'accent' }, 'Apply'));
    const current = renderToStaticMarkup(createElement(Button, { onClick: noop, variant: 'primary' }, 'Current'));
    expect(accent).toContain('arco-btn-primary');
    expect(current).toContain('arco-btn-secondary');
    expect(current).not.toContain('arco-btn-primary');
  });

  it('透传布局类名、表单与无障碍属性，不再附带旧 variant 皮肤类', () => {
    const html = renderToStaticMarkup(
      createElement(
        Button,
        {
          onClick: noop,
          className: 'toolbar-action',
          id: 'apply-button',
          type: 'submit',
          form: 'settings-form',
          tabIndex: -1,
          'aria-label': 'Apply settings',
          'aria-describedby': 'apply-hint',
          'aria-pressed': true,
          variant: 'accent',
        },
        'Apply',
      ),
    );
    expect(html).toContain('toolbar-action');
    expect(html).toContain('id="apply-button"');
    expect(html).toContain('type="submit"');
    expect(html).toContain('form="settings-form"');
    expect(html).toContain('tabindex="-1"');
    expect(html).toContain('aria-label="Apply settings"');
    expect(html).toContain('aria-describedby="apply-hint"');
    expect(html).toContain('aria-pressed="true"');
    expect(html).toContain('arco-btn-primary');
    expect(html).not.toContain('ui-button-accent');
  });
});

describe('shared Arco controls', () => {
  const noop = () => {};

  it('分段选项使用真实单选组并保留标签与紧凑尺寸', () => {
    const html = renderToStaticMarkup(
      createElement(Segmented, {
        value: 'http',
        options: [
          { value: 'stdio', label: 'Local' },
          { value: 'http', label: 'HTTP' },
        ],
        onChange: noop,
        disabled: true,
        size: 'compact',
        id: 'transport',
        ariaLabel: 'Transport',
      }),
    );
    expect(html).toContain('id="transport"');
    expect(html).toContain('aria-label="Transport"');
    expect(html).toContain('role="radiogroup"');
    expect(html).toContain('arco-radio-size-mini');
    expect(html.match(/type="radio"/g)).toHaveLength(2);
    expect(html.match(/disabled=""/g)).toHaveLength(2);
    expect(html).toMatch(/type="radio"[^>]*checked=""/);
  });

  it('开关直接使用带无障碍标签的 Arco 按钮', () => {
    const html = renderToStaticMarkup(
      createElement(Switch, {
        checked: true,
        id: 'enabled',
        label: 'Enable plugin',
        disabled: true,
        onChange: noop,
      }),
    );
    expect(html).toMatch(/^<button\b/);
    expect(html).toContain('arco-switch-small');
    expect(html).toContain('role="switch"');
    expect(html).toContain('aria-checked="true"');
    expect(html).toContain('aria-label="Enable plugin"');
    expect(html).toContain('id="enabled"');
    expect(html).toContain('disabled=""');
    expect(html).not.toContain('ui-switch-track');
    expect(html).toContain('arco-switch-dot');
    expect(html).not.toContain('style=');
  });

  it('设置行中的开关保持固有尺寸，不随 Grid 拉满整列', () => {
    const css = readFileSync(new URL('./arco-settings.css', import.meta.url), 'utf8');
    const rule = css.match(/\.ui-switch\s*\{([^}]+)\}/)?.[1];
    expect(rule).toContain('justify-self: start');
    expect(rule).toContain('flex-shrink: 0');
  });

  it('勾选框由 Arco 绘制半选状态并保留标签和禁用', () => {
    const html = renderToStaticMarkup(
      createElement(Checkbox, {
        checked: false,
        mixed: true,
        label: 'Select files',
        size: 'compact',
        disabled: true,
        onChange: noop,
      }),
    );
    expect(html).toContain('arco-checkbox-indeterminate');
    expect(html).toContain('arco-checkbox-mask');
    expect(html).toContain('ui-checkbox is-compact');
    expect(html).toContain('type="checkbox"');
    expect(html).toContain('disabled=""');
    expect(html).toContain('Select files');
  });

  it('错误提示、标签和空态使用真实 Arco 结构', () => {
    const alert = renderToStaticMarkup(createElement(Alert, { message: 'Cannot save' }));
    expect(alert).toContain('arco-alert-error');
    expect(alert).toContain('role="alert"');
    expect(alert).toContain('Cannot save');

    const tag = renderToStaticMarkup(createElement(Tag, { tone: 'amber', dot: true, children: 'Pending' }));
    expect(tag).toContain('arco-tag-gold');
    expect(tag).toContain('arco-tag-content');
    expect(tag).toContain('ui-tag-dot');

    const empty = renderToStaticMarkup(
      createElement(
        Empty,
        {
          title: 'No files',
          description: 'Nothing here',
          hint: 'Add a file',
        },
        createElement(Button, { onClick: noop }, 'Add'),
      ),
    );
    expect(empty).toContain('arco-empty-wrapper');
    expect(empty).toContain('ui-empty-wrap');
    expect(empty).toContain('No files');
    expect(empty).toContain('Nothing here');
    expect(empty).toContain('Add a file');
    expect(empty).toContain('ui-empty-actions');
    expect(empty).toContain('arco-btn');
  });

  it('折叠面板保留标题、说明、meta 和默认展开状态，关闭不卸载正文', () => {
    const panel = (defaultOpen: boolean) =>
      renderToStaticMarkup(
        createElement(CollapsiblePanel, {
          title: 'Server',
          subtitle: 'Connection',
          meta: createElement(Tag, { children: 'HTTP' }),
          defaultOpen,
          children: createElement('input', { defaultValue: 'Preserved' }),
        }),
      );
    const open = panel(true);
    expect(open).toContain('arco-collapse-item-active');
    expect(open).toContain('aria-expanded="true"');
    expect(open).toContain('collapsible-summary');
    expect(open).toContain('table-panel-title');
    expect(open).toContain('table-panel-tags');
    expect(open).toContain('Connection');
    expect(open).toContain('HTTP');
    const closed = panel(false);
    expect(closed).toContain('aria-expanded="false"');
    expect(closed).toContain('value="Preserved"');
  });
});
