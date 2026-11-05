import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { readScanCache, writeScanCache } from './frames.js';

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'mica-video-cache-'));
});

afterEach(() => rm(root, { recursive: true, force: true }));

describe('画面差异缓存', () => {
  it('写入后能读回来，并按 5 位小数量化', async () => {
    await writeScanCache(root, 'key-1', [0.123456789, 0.5]);
    expect(await readScanCache(root, 'key-1')).toEqual([0.12346, 0.5]);
  });

  // 空结果多半来自一次失败的解码：把它当命中，这条视频以后就再也不会重新扫描了。
  it('空结果不落盘', async () => {
    await writeScanCache(root, 'key-2', []);
    expect(await readScanCache(root, 'key-2')).toBeNull();
  });

  it('早先版本写下的空数组按未命中处理', async () => {
    const file = join(root, 'scenes', 'key-3.json');
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify({ diffs: [] }), 'utf8');
    expect(await readScanCache(root, 'key-3')).toBeNull();
    // 文件本身不动：它只是不被采信，下一次扫描会覆盖掉。
    expect(await readFile(file, 'utf8')).toContain('diffs');
  });

  it('形状不对的缓存按未命中处理', async () => {
    const file = join(root, 'scenes', 'key-4.json');
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify({ diffs: ['x'] }), 'utf8');
    expect(await readScanCache(root, 'key-4')).toBeNull();
  });
});
