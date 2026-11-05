import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, utimes, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { cacheStats, pruneCache, readScanCache, writeScanCache } from './frames.js';

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

const HOUR = 60 * 60 * 1000;

/** 写一个指定大小、指定「多久之前」的文件，用来控制淘汰顺序。 */
async function writeSized(path: string, bytes: number, ageMs = 0): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, Buffer.alloc(bytes, 7));
  const at = new Date(Date.now() - ageMs);
  await utimes(path, at, at);
}

describe('缓存淘汰', () => {
  it('超过上限时先删最旧的 source，一小时内下载的不动', async () => {
    const dir = join(root, 'sources');
    const oldest = join(dir, 'oldest.mp4');
    const older = join(dir, 'older.mp4');
    const fresh = join(dir, 'fresh.mp4');
    const partial = join(dir, 'half.mp4.part');
    await writeSized(oldest, 1024, 3 * HOUR);
    await writeSized(older, 1024, 2 * HOUR);
    await writeSized(fresh, 1024, 5 * 60 * 1000);
    await writeSized(partial, 1024, 3 * HOUR);

    await pruneCache(root, 1500);

    expect(existsSync(oldest)).toBe(false);
    expect(existsSync(older)).toBe(true);
    // 刚下载完的 source 可能正被 ffmpeg 读着抽帧。
    expect(existsSync(fresh)).toBe(true);
    // 半成品由下载路径自己清理。
    expect(existsSync(partial)).toBe(true);
  });

  it('帧图与 source 共用一个上限', async () => {
    const source = join(root, 'sources', 'source.mp4');
    const frame = join(root, 'frames', 'key-a', '1024-0.jpg');
    await writeSized(source, 1024, 2 * HOUR);
    await writeSized(frame, 1024, 30 * 60 * 1000);

    await pruneCache(root, 1500);

    expect(existsSync(source)).toBe(false);
    expect(existsSync(frame)).toBe(true);
  });
});

describe('缓存统计', () => {
  it('字节数含下载的 source，张数只数帧图', async () => {
    await writeSized(join(root, 'frames', 'key-b', '1024-0.jpg'), 300, HOUR);
    await writeSized(join(root, 'frames', 'key-b', '1024-1000.jpg'), 200, HOUR);
    await writeSized(join(root, 'sources', 'source.mp4'), 1024, 2 * HOUR);
    await writeSized(join(root, 'sources', 'half.mp4.part'), 4096, 2 * HOUR);

    expect(await cacheStats(root)).toEqual({ bytes: 1524, files: 2 });
  });

  it('只有下载缓存、还没有帧时也算出字节数', async () => {
    await writeSized(join(root, 'sources', 'source.mp4'), 4096, 2 * HOUR);
    expect(await cacheStats(root)).toEqual({ bytes: 4096, files: 0 });
  });
});
