import { readFileSync } from 'node:fs';
import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { ConversationDetailModal, RecordRow, RunRow, TurnHead } from './ConversationPane.js';
import type { ConfigWebConversationItem, ConfigWebConversationItemType } from '../../src/shared/types.js';

// 只替换 createPortal：Arco 的 `_util/is.js` 在模块加载时读 `ReactDOM.version`，
// 整个模块被替成 `{ createPortal }` 会让它拿到没有 `default` 导出的模块而崩在 collect 阶段。
vi.mock('react-dom', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-dom')>();
  return { ...actual, createPortal: (content: unknown) => content };
});

function item(sequence: number, type: ConfigWebConversationItemType, content = 'short'): ConfigWebConversationItem {
  return { sequence, type, content };
}

/**
 * 弹窗本体是 Arco `Modal`：它只在浏览器里挂载，`renderToStaticMarkup` 拿到的是一个空壳。
 * 所以先读组件交给 `Modal` 的 props（portal / 标题），再单独渲染正文验证内容。
 */
function renderDetail(records: ConfigWebConversationItem[]) {
  const element = ConversationDetailModal({ records, onClose: () => {} }) as {
    props: { portal?: boolean; wide?: boolean; title: string; children: ReactNode };
  };
  return {
    portal: element.props.portal,
    wide: element.props.wide,
    title: element.props.title,
    body: renderToStaticMarkup(createElement('div', null, element.props.children)),
  };
}

describe('conversation record rows', () => {
  it.each(['assistant', 'reasoning', 'tool_call', 'tool_result', 'system'] as const)(
    '%s opens a dialog without rendering inline content',
    (type) => {
      const record = item(2, type, 'long body\n'.repeat(100));
      const onOpen = vi.fn();
      const row = RecordRow({ item: record, onOpen });
      const button = row.props.children;
      button.props.onClick();
      expect(onOpen).toHaveBeenCalledWith([record]);
      const html = renderToStaticMarkup(row);
      expect(html).toContain('aria-haspopup="dialog"');
      expect(html).not.toMatch(/<details|<summary|<pre/);
    },
  );

  it('keeps turn statistics but opens only the user message', () => {
    const record = item(1, 'user', 'question\n'.repeat(100));
    const onOpen = vi.fn();
    const row = TurnHead({ item: record, stats: { records: 3, tools: 2, thinking: 1, chars: 60 }, onOpen });
    row.props.children.props.onClick();
    expect(onOpen).toHaveBeenCalledWith([record]);
    const html = renderToStaticMarkup(row);
    expect(html).toContain('3 条记录 · 工具 2 · 思考 1 · 60 字符');
    expect(html).not.toMatch(/<details|<pre/);
  });

  it('opens a grouped run in sequence rather than expanding the list', () => {
    const records = [item(2, 'reasoning'), item(3, 'tool_call'), item(4, 'tool_result'), item(5, 'reasoning')];
    const onOpen = vi.fn();
    const row = RunRow({ records, onOpen });
    row.props.children.props.onClick();
    expect(onOpen).toHaveBeenCalledWith(records);
    const html = renderToStaticMarkup(row);
    expect(html).toContain('2–5');
    expect(html).not.toMatch(/<details|<pre|conversation-run-body/);
  });

  it('uses one fixed height for all kinds and keeps previews single-line', () => {
    const css = readFileSync(new URL('../styles.css', import.meta.url), 'utf8');
    const row = css.match(/\.conversation-row-head \{([^}]+)\}/)?.[1];
    expect(row).toContain('height: 44px');
    expect(row).toContain('min-height: 44px');
    const assistant = css.match(/\.conversation-row-assistant > \.conversation-row-head \{([^}]+)\}/)?.[1];
    expect(assistant).not.toMatch(/height|padding|align-items/);
    expect(css.match(/\.conversation-turn-text \{([^}]+)\}/)?.[1]).toContain('white-space: nowrap');
    expect(css.match(/\.conversation-preview \{([^}]+)\}/)?.[1]).toContain('white-space: nowrap');
  });
});

describe('conversation detail dialog', () => {
  it('shows the complete original body and call metadata in a scoped portal', () => {
    const record = {
      ...item(7, 'tool_result', 'line\n'.repeat(900) + 'THE END'),
      toolName: 'run_shell',
      callId: 'call-7',
    };
    const { portal, wide, title, body } = renderDetail([record]);
    // 详情必须开在 document.body 上的独立弹窗里，不挤进对话列表（portal + 宽版）。
    expect(portal).toBe(true);
    expect(wide).toBe(true);
    expect(title).toBe('工具结果 · #7');
    expect(body).toContain('run_shell');
    expect(body).toContain('call-7');
    expect(body).toContain(record.content);
  });

  it('shows every grouped record in order and handles empty content', () => {
    const { body } = renderDetail([item(2, 'reasoning', 'thinking body'), item(3, 'tool_result', '')]);
    expect(body).toContain('2 条记录');
    expect(body.indexOf('thinking body')).toBeLessThan(body.indexOf('(空)'));
    expect(body.match(/class="conversation-content"/g)).toHaveLength(2);
  });
});
