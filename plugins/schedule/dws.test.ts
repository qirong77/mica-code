import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { latestAnnouncement, listChats, type DwsRunner } from './dws.js';

let cacheDir: string;
beforeEach(() => {
  cacheDir = mkdtempSync(join(tmpdir(), 'mica-schedule-export-'));
});
afterEach(() => rmSync(cacheDir, { recursive: true, force: true }));

it('错误信封和缺失数据不当成空公告，保留刷新失败的语义', async () => {
  for (const payload of [
    { ok: false, error: 'no permission' },
    { ok: true, data: {} },
  ]) {
    const run: DwsRunner = async (args) => {
      writeFileSync(args.at(-1)!, JSON.stringify(payload));
      return '';
    };
    await expect(latestAnnouncement(run, { cacheDir, chatId: 'group', from: '', to: '' })).rejects.toThrow(/dws 导出/);
    await expect(listChats(run, cacheDir)).rejects.toThrow(/dws 导出/);
    expect(readdirSync(cacheDir)).toEqual([]);
  }
});

it('命令写了部分导出后失败也会清理文件', async () => {
  const run: DwsRunner = async (args) => {
    writeFileSync(args.at(-1)!, '{partial');
    throw new Error('mock export failed');
  };
  await expect(latestAnnouncement(run, { cacheDir, chatId: 'group', from: '', to: '' })).rejects.toThrow(
    'mock export failed',
  );
  await expect(listChats(run, cacheDir)).rejects.toThrow('mock export failed');
  expect(readdirSync(cacheDir)).toEqual([]);
});
