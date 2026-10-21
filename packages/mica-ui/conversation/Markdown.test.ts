import React from 'react';
import { describe, expect, it } from 'vitest';
import { TerminalSizeContext } from '@packages/@anthropic/ink/src/components/TerminalSizeContext.js';
import { renderToScreen } from '@packages/@anthropic/ink/src/core/render-to-screen.js';
import { charInCellAt, type Screen } from '@packages/@anthropic/ink/src/core/screen.js';
import { Markdown, splitTerminalLink } from './Markdown.js';

const TABLE = [
  '| Priority | Command | Recommendation | Reason |',
  '|---|---|---|---|',
  '| P0 | `/config` | migrate immediately | command host already provides every required dependency |',
  '| P1 | `/provider` | migrate as a group | provider model and effort share configuration switching logic |',
].join('\n');

function screenLines(screen: Screen): string[] {
  const lines: string[] = [];
  for (let y = 0; y < screen.height; y++) {
    let line = '';
    for (let x = 0; x < screen.width; x++) {
      line += charInCellAt(screen, x, y) ?? ' ';
    }
    lines.push(line.trimEnd());
  }
  return lines;
}

function renderTable(columns: number): string[] {
  const tree = React.createElement(
    TerminalSizeContext.Provider,
    { value: { columns, rows: 40 } },
    React.createElement(Markdown, null, TABLE),
  );
  return screenLines(renderToScreen(tree, columns).screen);
}

function longestBorder(lines: string[]): number {
  return Math.max(0, ...lines.filter((line) => line.startsWith('┌')).map((line) => line.length));
}

describe('Markdown tables', () => {
  it('recalculates table width from the terminal size context', () => {
    const narrowBorder = longestBorder(renderTable(80));
    const wideBorder = longestBorder(renderTable(140));

    expect(narrowBorder).toBeGreaterThan(0);
    expect(wideBorder).toBeGreaterThan(narrowBorder);
    expect(wideBorder).toBeLessThanOrEqual(140);
  });
});

function renderLine(text: string): string {
  const tree = React.createElement(
    TerminalSizeContext.Provider,
    { value: { columns: 120, rows: 10 } },
    React.createElement(Markdown, null, text),
  );
  return screenLines(renderToScreen(tree, 120).screen)[0] ?? '';
}

describe('Markdown autolinks', () => {
  it('cuts the full-width punctuation out of the link target', () => {
    expect(splitTerminalLink('http://10.190.46.109:9200。', 'http://10.190.46.109:9200。')).toEqual({
      url: 'http://10.190.46.109:9200',
      text: 'http://10.190.46.109:9200',
      trailing: '。',
    });
  });

  it('cuts the Chinese sentence marked swallowed after the URL', () => {
    expect(splitTerminalLink('https://example.com/a，然后继续', 'https://example.com/a，然后继续')).toEqual({
      url: 'https://example.com/a',
      text: 'https://example.com/a',
      trailing: '，然后继续',
    });
  });

  it('keeps an explicit link target with a punctuated label', () => {
    expect(splitTerminalLink('https://example.com/a。', '看这里')).toBeNull();
  });

  it('renders the sentence with a single full stop', () => {
    expect(renderLine('已部署到 http://10.190.46.109:9200。')).toBe('已部署到 http://10.190.46.109:9200。');
    expect(renderLine('见 https://example.com/a，然后继续')).toBe('见 https://example.com/a，然后继续');
  });
});
