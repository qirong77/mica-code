import { readFileSync } from 'node:fs';
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ArcoProvider } from '@mica-config-ui/web';
import {
  ClipboardEmpty,
  ClipboardThumbnail,
  FILTERS,
  Launcher,
  PreviewPane,
  card,
  formatBytes,
  formatShortcut,
  formatWhen,
  resolveShortcut,
  safeImageSource,
  systemNotice,
} from './desktop.jsx';
import DefaultLauncher from './desktop.jsx';

const css = readFileSync(new URL('./desktop.css', import.meta.url), 'utf8');

function render(element: React.ReactElement): string {
  return renderToStaticMarkup(React.createElement(ArcoProvider, { children: element }));
}

function buttonFor(html: string, label: string): string | undefined {
  return html.match(/<button\b[\s\S]*?<\/button>/g)?.find((tag) => tag.includes(label));
}

function press(overrides: Record<string, unknown>) {
  return { key: '', code: '', metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...overrides };
}

const textItem = {
  id: 'a1',
  title: '构建日志',
  kind: 'text' as const,
  textPreview: 'pnpm build 通过',
  source: { name: 'Mica', bundleId: 'dev.mica' },
  pinned: false,
  pinKey: '',
  createdAt: Date.now() - 5000,
  lastCopiedAt: Date.now() - 5000,
  copyCount: 2,
  bytes: 2048,
};

const imageItem = {
  ...textItem,
  id: 'a2',
  title: '截图',
  kind: 'image' as const,
  textPreview: '',
  bytes: 512 * 1024,
};

const filesItem = {
  ...textItem,
  id: 'a3',
  title: '三个文件',
  kind: 'files' as const,
  textPreview: '',
};

beforeEach(() => {
  vi.stubGlobal('React', React);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('模块出口', () => {
  it('导出 Launcher / default 与清单筛选值', () => {
    expect(typeof Launcher).toBe('function');
    expect(DefaultLauncher).toBe(Launcher);
    expect(card.width).toBeGreaterThanOrEqual(240);
    expect(FILTERS.map((entry: { value: string }) => entry.value)).toEqual(['all', 'pinned', 'text', 'image', 'files']);
  });

  it('样式表不分层压 Arco，也不用 !important', () => {
    expect(css).not.toContain('!important');
    expect(css).not.toMatch(/(?:^|})\s*\.arco-input(?:[\s:.,{])/);
  });
});

describe('快捷键决策', () => {
  const pinnedKeys = new Map([['a', 'pinned-1']]);

  it('⌘1…9 复制对应条目，⌥ 变粘贴、⌥⇧ 变纯文本', () => {
    expect(resolveShortcut(press({ key: '1', code: 'Digit1', metaKey: true }))).toEqual({
      type: 'select',
      index: 0,
      mode: 'copy',
    });
    expect(resolveShortcut(press({ key: '9', code: 'Digit9', metaKey: true }))).toEqual({
      type: 'select',
      index: 8,
      mode: 'copy',
    });
    expect(resolveShortcut(press({ key: '2', code: 'Digit2', altKey: true }))).toEqual({
      type: 'select',
      index: 1,
      mode: 'paste',
    });
    // ⌥⇧2 在美式布局上是 @，判断只认 code。
    expect(resolveShortcut(press({ key: '@', code: 'Digit2', altKey: true, shiftKey: true }))).toEqual({
      type: 'select',
      index: 1,
      mode: 'plain',
    });
  });

  it('回车三兄弟与 Esc', () => {
    expect(resolveShortcut(press({ key: 'Enter', code: 'Enter' }))).toEqual({ type: 'select', mode: 'default' });
    expect(resolveShortcut(press({ key: 'Enter', code: 'Enter', altKey: true }))).toEqual({
      type: 'select',
      mode: 'paste',
    });
    expect(resolveShortcut(press({ key: 'Enter', code: 'Enter', altKey: true, shiftKey: true }))).toEqual({
      type: 'select',
      mode: 'plain',
    });
    expect(resolveShortcut(press({ key: 'Escape', code: 'Escape' }))).toEqual({ type: 'escape' });
  });

  it('固定 / 删除 / 清理 / 设置', () => {
    // ⌥P 在 macOS 上 key 是 π，判定必须看 code。
    expect(resolveShortcut(press({ key: 'π', code: 'KeyP', altKey: true }))).toEqual({ type: 'pin' });
    expect(resolveShortcut(press({ key: 'Backspace', code: 'Backspace', altKey: true }))).toEqual({
      type: 'delete',
    });
    expect(resolveShortcut(press({ key: 'Backspace', code: 'Backspace', altKey: true, metaKey: true }))).toEqual({
      type: 'clear',
      includePinned: false,
    });
    expect(
      resolveShortcut(press({ key: 'Backspace', code: 'Backspace', altKey: true, metaKey: true, shiftKey: true })),
    ).toEqual({ type: 'clear', includePinned: true });
    expect(resolveShortcut(press({ key: ',', code: 'Comma', metaKey: true }))).toEqual({ type: 'configure' });
  });

  it('↑↓ / Home / End 移动，普通输入与输入法组字不拦截', () => {
    expect(resolveShortcut(press({ key: 'ArrowDown', code: 'ArrowDown' }))).toEqual({ type: 'move', to: 'next' });
    expect(resolveShortcut(press({ key: 'ArrowUp', code: 'ArrowUp' }))).toEqual({ type: 'move', to: 'prev' });
    expect(resolveShortcut(press({ key: 'Home', code: 'Home' }))).toEqual({ type: 'move', to: 'first' });
    expect(resolveShortcut(press({ key: 'End', code: 'End' }))).toEqual({ type: 'move', to: 'last' });
    expect(resolveShortcut(press({ key: 'n', code: 'KeyN' }))).toBeNull();
    expect(resolveShortcut(press({ key: 'n', code: 'KeyN', composing: true }))).toBeNull();
    expect(resolveShortcut(press({ key: 'n', code: 'KeyN', altKey: true }), { pinnedKeys })).toBeNull();
  });

  it('固定条目的字母快捷键跳到那一条', () => {
    expect(resolveShortcut(press({ key: 'å', code: 'KeyA', altKey: true }), { pinnedKeys })).toEqual({
      type: 'select',
      id: 'pinned-1',
      mode: 'copy',
    });
  });
});

describe('安全与格式', () => {
  it('只接受内联光栅图片', () => {
    expect(safeImageSource('data:image/png;base64,iVBORw0KGgo=')).toBe('data:image/png;base64,iVBORw0KGgo=');
    expect(safeImageSource('  data:image/jpeg;base64,/9j/4AAQ  ')).toBe('data:image/jpeg;base64,/9j/4AAQ');
    expect(safeImageSource('https://example.com/x.png')).toBe('');
    expect(safeImageSource('data:image/svg+xml;base64,PHN2Zz4=')).toBe('');
    expect(safeImageSource(null)).toBe('');
  });

  it('字节与时间按人读的方式呈现', () => {
    expect(formatBytes(0)).toBe('');
    expect(formatBytes(900)).toBe('900 B');
    expect(formatBytes(2048)).toBe('2 KB');
    expect(formatBytes(5 * 1024 * 1024)).toBe('5.0 MB');
    const now = new Date('2026-11-20T12:00:00').getTime();
    expect(formatWhen(now - 5_000, now)).toBe('刚刚');
    expect(formatWhen(now - 8 * 60_000, now)).toBe('8 分钟前');
    expect(formatWhen(now - 3 * 3_600_000, now)).toBe('09:00');
    expect(formatWhen('2026-10-02T08:30:00', now)).toBe('10月2日');
    expect(formatWhen('not-a-date', now)).toBe('');
  });

  it('快捷键按 Apple 的写法显示', () => {
    expect(formatShortcut('CommandOrControl+Shift+C')).toBe('⇧⌘C');
    expect(formatShortcut('Control+Alt+Shift+Meta+P')).toBe('⌃⌥⇧⌘P');
    expect(formatShortcut('Alt+Space')).toBe('⌥Space');
    expect(formatShortcut('F5')).toBe('F5');
    expect(formatShortcut('')).toBe('');
  });

  it('系统问题只留一条能修的提示', () => {
    expect(systemNotice({ native: { supported: false, error: '没有剪贴板' } })).toMatchObject({
      key: 'native',
      text: '没有剪贴板',
    });
    expect(systemNotice({ native: { supported: true, accessibility: false } })).toMatchObject({
      key: 'accessibility',
      action: 'native',
    });
    expect(
      systemNotice({
        native: { supported: true, accessibility: true },
        status: { registered: false, shortcut: '⇧⌘C' },
      }),
    ).toMatchObject({
      key: 'shortcut',
      action: 'retry',
    });
    expect(systemNotice({ native: { supported: true, accessibility: true, error: '辅助进程已退出' } })).toMatchObject({
      key: 'native-error',
      text: '辅助进程已退出',
      action: 'native',
    });
    expect(systemNotice({ native: { supported: true, accessibility: true }, status: { registered: true } })).toBeNull();
  });
});

describe('空态', () => {
  it('没有历史时说明怎么开始', () => {
    const html = render(React.createElement(ClipboardEmpty, {}));
    expect(html).toContain('还没有复制过任何内容');
    expect(html).toContain('就会出现在这里');
  });

  it('搜索、筛选、暂停各有各的说法与出口', () => {
    const search = render(React.createElement(ClipboardEmpty, { query: ' 报告 ', onClearQuery: () => {} }));
    expect(search).toContain('没有找到「报告」');
    expect(search).toContain('清除搜索');

    const filtered = render(React.createElement(ClipboardEmpty, { filter: 'pinned', onShowAll: () => {} }));
    expect(filtered).toContain('还没有固定条目');
    expect(filtered).toContain('查看全部');

    const paused = render(React.createElement(ClipboardEmpty, { paused: true, onResume: () => {} }));
    expect(paused).toContain('记录已暂停');
    expect(paused).toContain('继续记录');
  });
});

describe('内容预览', () => {
  it('图片列表绘制缩略图，缺失或不安全的来源保留图片图标', () => {
    const image = render(React.createElement(ClipboardThumbnail, { source: 'data:image/png;base64,iVBORw0KGgo=' }));
    expect(image).toContain('alt="图片缩略图"');
    expect(image).toContain('src="data:image/png;base64,iVBORw0KGgo="');
    const missing = render(React.createElement(ClipboardThumbnail, {}));
    const unsafe = render(React.createElement(ClipboardThumbnail, { source: 'https://example.com/tracker.png' }));
    expect(missing).not.toContain('<img');
    expect(unsafe).not.toContain('<img');
    expect(unsafe).toContain('aria-label="图片"');
  });
  it('文本条目显示全文，不只有列表里的摘要', () => {
    const html = render(
      React.createElement(PreviewPane, {
        item: textItem,
        detail: {
          id: 'a1',
          item: textItem,
          text: '第一行\n第二行',
          previewImage: null,
          files: [],
          types: ['public.utf8-plain-text'],
        },
      }),
    );
    expect(html).toContain('<pre class="maccy-preview-text">第一行\n第二行</pre>');
    expect(html).not.toContain('public.utf8-plain-text');
  });

  it('图片条目只画安全的 data URL 预览', () => {
    const safe = render(
      React.createElement(PreviewPane, {
        item: imageItem,
        detail: {
          id: 'a2',
          item: imageItem,
          text: '',
          previewImage: 'data:image/png;base64,iVBORw0KGgo=',
          files: [],
          types: [],
        },
      }),
    );
    expect(safe).toMatch(/<img[^>]*class="maccy-preview-image"[^>]*src="data:image\/png;base64,iVBORw0KGgo="/);

    const unsafe = render(
      React.createElement(PreviewPane, {
        item: imageItem,
        detail: {
          id: 'a2',
          item: imageItem,
          text: '',
          previewImage: 'https://example.com/x.png',
          files: [],
          types: [],
        },
      }),
    );
    expect(unsafe).not.toContain('<img');
    expect(unsafe).toContain('这张图片没有可用的预览。');
  });

  it('文件条目逐行列出路径，预览里不再摆动作按钮', () => {
    const html = render(
      React.createElement(PreviewPane, {
        item: filesItem,
        detail: {
          id: 'a3',
          item: filesItem,
          text: '',
          previewImage: null,
          files: ['/tmp/a.txt', '/tmp/b.txt'],
          types: [],
        },
      }),
    );
    expect(html).toContain('/tmp/a.txt');
    expect(html).toContain('/tmp/b.txt');
    // 动作收在右键菜单里：预览只负责看清内容，底栏只留来源与占用空间。
    expect(html).not.toContain('maccy-preview-actions');
    for (const label of ['复制', '粘贴', '纯文本', '固定', '重命名', '删除']) {
      expect(buttonFor(html, label), `unexpected action: ${label}`).toBeUndefined();
    }
  });

  it('固定条目的预览标出已固定，但不带操作按钮', () => {
    const pinned = { ...textItem, pinned: true, pinKey: 'b' };
    const html = render(
      React.createElement(PreviewPane, {
        item: pinned,
        detail: { id: 'a1', item: pinned, text: '正文', previewImage: null, files: [], types: [] },
      }),
    );
    expect(html).toContain('已固定');
    expect(buttonFor(html, '取消固定')).toBeUndefined();
    expect(html).not.toContain('⌥b');
  });
});

describe('浮窗首屏', () => {
  it('画搜索行、类型筛选与空的头部（没有一排图标动作）', () => {
    const html = render(React.createElement(Launcher, { api: { launcher: {} } }));
    const input = html.match(/<input\b[^>]*>/g)?.find((tag) => tag.includes('maccy-input'));
    expect(input).toContain('placeholder="搜索剪贴板…"');
    expect(input).toContain('aria-label="搜索剪贴板"');
    expect(input).toContain('role="combobox"');

    // 顶部只剩搜索：暂停 / 忽略一次 / 清理 / 设置 / 关闭都不再占位置。
    for (const title of ['暂停记录', '忽略下一次复制', '清理历史', '设置', '关闭']) {
      expect(buttonFor(html, title), `unexpected header action: ${title}`).toBeUndefined();
    }
    for (const label of ['全部', '固定', '文本', '图片', '文件']) {
      expect(html, `missing filter: ${label}`).toContain(label);
    }
    expect(html).toContain('正在载入剪贴板历史…');
    expect(html).toContain('右键更多');
    expect(html).toContain('Esc 关闭');
  });

  it('没有启动器 API 时也不崩，只留空列表', () => {
    const html = render(React.createElement(Launcher, { api: {} }));
    expect(html).toContain('maccy');
    expect(html).not.toContain('maccy-dialog');
  });
});
