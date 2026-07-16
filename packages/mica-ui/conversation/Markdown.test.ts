import React from 'react';
import { describe, expect, it } from 'vitest';
import { TerminalSizeContext } from '@packages/@anthropic/ink/src/components/TerminalSizeContext.js';
import { renderToScreen } from '@packages/@anthropic/ink/src/core/render-to-screen.js';
import { charInCellAt, type Screen } from '@packages/@anthropic/ink/src/core/screen.js';
import { Markdown } from './Markdown.js';

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
