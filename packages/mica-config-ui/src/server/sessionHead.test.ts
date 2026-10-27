import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readSessionHead, summarizeSessionFile } from './sessionHead.js';

function withSessionFile(content: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'mica-session-head-'));
  const path = join(dir, '20260101T000000Z-abcdef.json');
  writeFileSync(path, content);
  return path;
}

const SAMPLE = `{
  "version": 1,
  "id": "20260101T000000Z-abcdef",
  "title": "登录超时排查",
  "titleSource": "auto",
  "cwd": "/Users/x/projects/mica",
  "turnState": "completed",
  "snapshot": {
    "providerId": "deepseek",
    "model": "deepseek-flash",
    "history": []
  }
}`;

describe('readSessionHead', () => {
  it('reads the list fields without parsing the whole snapshot', () => {
    const head = readSessionHead(withSessionFile(SAMPLE));
    expect(head).toEqual({
      title: '登录超时排查',
      cwd: '/Users/x/projects/mica',
      turnState: 'completed',
      model: 'deepseek-flash',
    });
  });

  it('ignores similar keys and keeps the snapshot model', () => {
    // `titleSource` 不能被当成 `title`，会话末尾的 usage 记录也不能顶掉 snapshot.model。
    const head = readSessionHead(
      withSessionFile(`{
  "titleSource": "manual",
  "title": "标题",
  "usageHistory": [{ "model": "别的模型" }],
  "snapshot": { "model": "deepseek-flash" }
}`),
    );
    expect(head.title).toBe('标题');
    expect(head.model).toBe('deepseek-flash');
  });

  it('unterminated strings do not throw', () => {
    const path = withSessionFile('{"title": "写到一半');
    expect(() => readSessionHead(path)).not.toThrow();
    expect(readSessionHead(path).title).toBeUndefined();
  });
});

describe('summarizeSessionFile', () => {
  it('falls back to the id when the title is missing', () => {
    const path = withSessionFile('{"cwd": "/tmp"}');
    const summary = summarizeSessionFile(path, '20260101T000000Z-abcdef');
    expect(summary.title).toBe('20260101T000000Z-abcdef');
    expect(summary.cwd).toBe('/tmp');
    expect(summary.sizeBytes).toBeGreaterThan(0);
  });
});
