import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { normalizePromptControls, readPromptControls, writePromptControls } from './promptControls.js';

const empty = () => ({ version: 1 as const, disabledPlugins: [], sections: {} });
let directory: string;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'mica-prompt-controls-'));
  vi.stubEnv('MICA_HOME', directory);
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(directory, { recursive: true, force: true });
});

describe('prompt controls storage', () => {
  it('defaults only when missing and returns independent values', () => {
    const first = readPromptControls();
    first.disabledPlugins.push('changed');
    expect(readPromptControls()).toEqual(empty());
    expect(readdirSync(directory)).toEqual([]);
  });

  it('persists plugin and section switches, edits and restoration with private permissions', () => {
    const controls = {
      version: 1,
      disabledPlugins: ['notes', 'notes'],
      sections: { role: { enabled: false }, 'plugin:notes/rules': { content: 'custom instructions' } },
    };
    const saved = writePromptControls(controls);
    expect(saved.disabledPlugins).toEqual(['notes']);
    expect(readPromptControls()).toEqual(saved);
    expect(statSync(join(directory, 'prompt-controls.json')).mode & 0o777).toBe(0o600);
    expect(readdirSync(directory)).toEqual(['prompt-controls.json']);
    writePromptControls(empty());
    expect(readPromptControls()).toEqual(empty());
  });

  it.each([
    null,
    [],
    {},
    { version: 2, disabledPlugins: [], sections: {} },
    { version: 1, disabledPlugins: 'notes', sections: {} },
    { version: 1, disabledPlugins: [false], sections: {} },
    { version: 1, disabledPlugins: [], sections: [] },
    { version: 1, disabledPlugins: [], sections: { role: null } },
    { version: 1, disabledPlugins: [], sections: { role: { enabled: 'false' } } },
    { version: 1, disabledPlugins: [], sections: { role: { content: 42 } } },
    { version: 1, disabledPlugins: [], sections: { role: { typo: true } } },
    { version: 1, disabledPlugins: [], sections: { system: { content: 'replace base' } } },
    { version: 1, disabledPlugins: [], sections: { system: { enabled: false } } },
    { version: 1, disabledPlugins: [], sections: { unknown: {} } },
    { version: 1, disabledPlugins: [], sections: {}, order: 'role' },
    { version: 1, disabledPlugins: [], sections: {}, order: [false] },
    { version: 1, disabledPlugins: [], sections: {}, order: ['system'] },
  ])('rejects malformed writes without replacing the saved document (%j)', (input) => {
    writePromptControls({ ...empty(), disabledPlugins: ['keep'] });
    const path = join(directory, 'prompt-controls.json');
    const before = readFileSync(path, 'utf8');
    expect(() => writePromptControls(input)).toThrow(/Invalid prompt controls/);
    expect(readFileSync(path, 'utf8')).toBe(before);
  });

  it('rejects overlong sections and oversized combined documents without truncation', () => {
    expect(() => normalizePromptControls({ ...empty(), sections: { role: { content: 'x'.repeat(200_001) } } })).toThrow(
      /200000/,
    );
    expect(() =>
      writePromptControls({
        ...empty(),
        sections: Object.fromEntries(
          Array.from({ length: 8 }, (_, i) => [`plugin:p/${i}`, { content: '文'.repeat(100_000) }]),
        ),
      }),
    ).toThrow(/1 MB/);
    expect(readdirSync(directory)).toEqual([]);
  });

  it('reports corrupt or unsupported files instead of silently enabling everything', () => {
    const path = join(directory, 'prompt-controls.json');
    writeFileSync(path, '{broken');
    expect(() => readPromptControls()).toThrow(/Cannot read/);
    writeFileSync(path, JSON.stringify({ ...empty(), version: 2 }));
    expect(() => readPromptControls()).toThrow(/version must be 1/);
  });

  it('stores the drag order, dedupes it and keeps an untouched document free of one', () => {
    const saved = writePromptControls({
      ...empty(),
      order: ['plugin:notes/rules', 'context', 'plugin:notes/rules'],
    });
    expect(saved.order).toEqual(['plugin:notes/rules', 'context']);
    expect(readPromptControls().order).toEqual(['plugin:notes/rules', 'context']);
    // 没有拖动过就不写这个字段：旧文档读出来仍然没有 order，提示词排列不受影响。
    expect(writePromptControls({ ...empty(), order: [] }).order).toBeUndefined();
    expect(readPromptControls().order).toBeUndefined();
  });
});
