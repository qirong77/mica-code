import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it } from 'vitest';
import { setConfigWebClient } from '../api.js';
import type { ConfigWebClient } from '../api.js';
import { PathLink } from './PathLink.js';

afterEach(() => {
  setConfigWebClient(null);
});

/** 只声明本次要验的那几个动作：其余数据操作路径链接根本不会碰。 */
function pathOnlyClient(partial: Partial<ConfigWebClient>): ConfigWebClient {
  return partial as ConfigWebClient;
}

function render(node: React.ReactElement): string {
  return renderToStaticMarkup(node);
}

describe('路径链接', () => {
  it('宿主两个动作都没有时退回纯文本', () => {
    const html = render(createElement(PathLink, { path: '/tmp/plugin-todo.log' }));
    expect(html).toContain('/tmp/plugin-todo.log');
    expect(html).not.toContain('<button');
    expect(html).not.toContain('path-link');
  });

  it('宿主能打开时渲染成按钮，标题里有完整路径', () => {
    setConfigWebClient(
      pathOnlyClient({
        revealPath: async () => ({ ok: true }),
        openPathInEditor: async () => ({ ok: true }),
      })
    );
    const html = render(createElement(PathLink, { path: '/tmp/plugin-todo.log' }));
    expect(html).toContain('class="path-link"');
    expect(html).toContain('/tmp/plugin-todo.log');
    // 只开一个动作时少一个选项：这里两个都有，标题提一句快捷键
    expect(html).toContain('⌘ / Ctrl');
  });

  it('只有「在 Finder 中打开」时不提编辑器快捷键', () => {
    setConfigWebClient(pathOnlyClient({ revealPath: async () => ({ ok: true }) }));
    const html = render(createElement(PathLink, { path: '/tmp/plugin-todo.log' }));
    expect(html).toContain('class="path-link"');
    expect(html).not.toContain('⌘ / Ctrl');
  });

  it('自定义展示文本时显示文本，路径留在标题里', () => {
    setConfigWebClient(pathOnlyClient({ revealPath: async () => ({ ok: true }) }));
    const html = render(createElement(PathLink, { path: '/tmp/plugin-todo.log', text: '今天的日志' }));
    expect(html).toContain('今天的日志');
    expect(html).toContain('title="/tmp/plugin-todo.log');
  });
});
