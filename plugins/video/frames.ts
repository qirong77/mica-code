import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { createWriteStream } from 'node:fs';
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { once } from 'node:events';
import { homedir } from 'node:os';
import { dirname, extname, join, resolve } from 'node:path';
import { resolveMicaHome } from '@packages/mica-config/brand.js';
import { extractFrame, type FfmpegTools } from './ffmpeg.js';
import type { FrameRequest } from './plan.js';

/**
 * 帧的缓存与落盘。
 *
 * 抽帧要 spawn 一次 ffmpeg，对同一个视频追问第二次就必须命中缓存——按「热路径不许起子进程」
 * 的口径，缓存不是优化而是前提。缓存键同时含视频身份、缩略尺寸与时刻，所以换 maxEdge 不会
 * 命中一份尺寸不对的旧图。
 */

const MAX_CONCURRENT_EXTRACTIONS = 4;
const PRUNE_EVERY_N_WRITES = 25;
const DOWNLOAD_TIMEOUT_MS = 60_000;
/** 远程视频的大小上限。理解视频是一次看几帧，没有理由为它拉一个几 GB 的文件。 */
const MAX_DOWNLOAD_BYTES = 2 * 1024 * 1024 * 1024;
/** 下载完的 source 马上会被 ffmpeg 读着抽帧，可能持续几分钟，这段时间内不许淘汰。 */
const SOURCE_MIN_AGE_MS = 60 * 60 * 1000;

export type ExtractedFrame = {
  requested?: string;
  seconds: number;
  path: string;
  bytes: number;
};

export type FrameCacheOptions = {
  /** `$MICA_HOME` 下的视频缓存根目录。 */
  root: string;
  maxEdge: number;
  limitBytes: number;
  tools: FfmpegTools;
  signal?: AbortSignal;
};

/** 视频身份：路径 + 大小 + mtime。改了视频内容就会换一个 key，不会读到旧帧。 */
export function videoCacheKey(filePath: string, size: number, mtimeMs: number): string {
  return createHash('sha1')
    .update(`${resolve(filePath)}\0${size}\0${Math.round(mtimeMs)}`)
    .digest('hex')
    .slice(0, 16);
}

export function framesDir(root: string, key: string): string {
  return join(root, 'frames', key);
}

function scenesFile(root: string, key: string): string {
  return join(root, 'scenes', `${key}.json`);
}

/**
 * 画面差分扫描要整片解码，同一条视频反复调用时不该重扫一遍。
 *
 * 键里已经有「路径 + 大小 + mtime」，文件改过就是另一个键，不会读到过期的结果。
 */
export async function readScanCache(root: string, key: string): Promise<number[] | null> {
  const raw = await readFile(scenesFile(root, key), 'utf8').catch(() => null);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as { diffs?: unknown };
    if (!Array.isArray(parsed.diffs) || !parsed.diffs.every((value) => typeof value === 'number')) return null;
    // 空数组等于「没扫到东西」，不是有效结果：当成命中会让这条视频永远不再重新扫描。
    if (parsed.diffs.length === 0) return null;
    return parsed.diffs as number[];
  } catch {
    return null;
  }
}

export async function writeScanCache(root: string, key: string, diffs: number[]): Promise<void> {
  // 失败与空结果不落盘：一次解码错误不该把「没有画面差异」永久钉在这条视频上。
  if (diffs.length === 0) return;
  const target = scenesFile(root, key);
  await mkdir(dirname(target), { recursive: true });
  // 差异值量化到 5 位小数：只是用来找峰，再精确也没意义，压缩后体积小一个量级。
  const payload = JSON.stringify({ diffs: diffs.map((value) => Math.round(value * 100000) / 100000) });
  await writeFile(target, payload, 'utf8').catch(() => undefined);
}

/** 时刻换算成毫秒当文件名，避免 `4:50.0` 里的冒号在小写文件系统上出问题。 */
function frameFileName(maxEdge: number, seconds: number): string {
  return `${maxEdge}-${Math.round(seconds * 1000)}.jpg`;
}

export async function ensureFrames(
  options: FrameCacheOptions & { videoPath: string; key: string; requests: FrameRequest[] },
): Promise<ExtractedFrame[]> {
  const { root, key, maxEdge, requests, tools, signal } = options;
  const dir = framesDir(root, key);
  await mkdir(dir, { recursive: true });

  const results: (ExtractedFrame | undefined)[] = new Array(requests.length);
  let wrote = 0;

  const runOne = async (index: number): Promise<void> => {
    const request = requests[index]!;
    const filePath = join(dir, frameFileName(maxEdge, request.seconds));
    const base = { requested: request.requested, seconds: request.seconds };

    if (existsSync(filePath)) {
      const info = await stat(filePath);
      if (info.size > 0) {
        results[index] = { ...base, path: filePath, bytes: info.size };
        return;
      }
    }

    await extractFrame({
      ffmpegPath: tools.ffmpegPath,
      videoPath: options.videoPath,
      seconds: request.seconds,
      maxEdge,
      outputPath: filePath,
      signal,
    });
    const info = await stat(filePath);
    wrote += 1;
    results[index] = { ...base, path: filePath, bytes: info.size };
  };

  await mapWithConcurrency(requests, MAX_CONCURRENT_EXTRACTIONS, (_, index) => runOne(index));

  const extracted = results.filter((frame): frame is ExtractedFrame => frame !== undefined);
  if (extracted.length !== requests.length) {
    throw new Error(`抽帧不完整：请求 ${requests.length} 帧，只拿到 ${extracted.length} 帧`);
  }
  if (wrote > 0) maybePrune(root, options.limitBytes);
  return extracted;
}

/** 远程视频先落盘再当本地文件处理：ffmpeg 的 seek 需要可随机访问的输入。 */
export async function downloadSource(url: string, root: string, signal?: AbortSignal): Promise<{ path: string; key: string }> {
  const dir = join(root, 'sources');
  await mkdir(dir, { recursive: true });
  const hash = createHash('sha1').update(url).digest('hex').slice(0, 16);
  const ext = guessExtension(url);
  const filePath = join(dir, `${hash}${ext}`);

  if (existsSync(filePath)) {
    const info = await stat(filePath);
    if (info.size > 0) return { path: filePath, key: `${hash}-${info.size}` };
  }

  const controller = new AbortController();
  const forwardAbort = () => controller.abort(signal?.reason);
  signal?.addEventListener('abort', forwardAbort, { once: true });
  const timeout = setTimeout(() => controller.abort(new Error('视频下载超过 60 秒')), DOWNLOAD_TIMEOUT_MS);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`);
    if (!response.body) throw new Error('下载响应没有正文');

    const declared = Number(response.headers.get('content-length') ?? 0);
    if (Number.isFinite(declared) && declared > MAX_DOWNLOAD_BYTES) {
      throw new Error(`远程视频 ${formatMegaBytes(declared)}，超过 ${formatMegaBytes(MAX_DOWNLOAD_BYTES)} 上限`);
    }

    // 边收边写：整段攒在内存里的话，一个几百 MB 的视频就是几百 MB 常驻内存。
    const partialPath = `${filePath}.part`;
    const stream = createWriteStream(partialPath);
    let total = 0;
    try {
      for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
        const buffer = Buffer.from(chunk);
        total += buffer.length;
        if (total > MAX_DOWNLOAD_BYTES) {
          throw new Error(`远程视频超过 ${formatMegaBytes(MAX_DOWNLOAD_BYTES)} 上限，已停止下载`);
        }
        if (!stream.write(buffer)) await once(stream, 'drain');
      }
      await new Promise<void>((resolve, reject) => {
        stream.end((error?: Error | null) => (error ? reject(error) : resolve()));
      });
    } catch (error) {
      stream.destroy();
      await rm(partialPath, { force: true }).catch(() => undefined);
      throw error;
    }
    await rename(partialPath, filePath);
    return { path: filePath, key: `${hash}-${total}` };
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener('abort', forwardAbort);
  }
}

export async function readFrameBase64(frame: ExtractedFrame): Promise<string> {
  const buffer = await readFile(frame.path);
  return buffer.toString('base64');
}

export async function cacheStats(root: string): Promise<{ bytes: number; files: number }> {
  const dir = join(root, 'frames');
  let bytes = 0;
  let files = 0;
  for (const key of await readdir(dir).catch(() => [] as string[])) {
    const frameDir = join(dir, key);
    for (const name of await readdir(frameDir).catch(() => [] as string[])) {
      const info = await stat(join(frameDir, name)).catch(() => null);
      if (!info?.isFile()) continue;
      bytes += info.size;
      files += 1;
    }
  }
  // 下载的远程视频同样占着磁盘，体积算进 bytes；但 files 只数帧图——状态页说的是能直接取用的画面。
  for (const source of await listSources(root)) bytes += source.bytes;
  return { bytes, files };
}

type CacheFile = { path: string; bytes: number; mtimeMs: number };

/** `sources/` 下的成品文件。`.part` 是下载中的半成品，由下载失败路径自己清理，这里一概不碰。 */
async function listSources(root: string): Promise<CacheFile[]> {
  const dir = join(root, 'sources');
  const files: CacheFile[] = [];
  for (const name of await readdir(dir).catch(() => [] as string[])) {
    if (name.endsWith('.part')) continue;
    const path = join(dir, name);
    const info = await stat(path).catch(() => null);
    if (!info?.isFile()) continue;
    files.push({ path, bytes: info.size, mtimeMs: info.mtimeMs });
  }
  return files;
}

let writesSinceLastPrune = 0;
let pruning = false;

/**
 * 超过上限就从最旧的开始删（帧目录与下载的远程视频共用同一个上限）。
 *
 * 不是每次写入都扫目录（几百个文件 stat 一遍没必要），攒够几十次写才检查一次；
 * 同时用一个 in-process 标志避免两轮抽取同时清理同一份目录。
 */
function maybePrune(root: string, limitBytes: number): void {
  writesSinceLastPrune += 1;
  if (writesSinceLastPrune < PRUNE_EVERY_N_WRITES || pruning) return;
  writesSinceLastPrune = 0;
  pruning = true;
  void pruneCache(root, limitBytes)
    .catch(() => undefined)
    .finally(() => {
      pruning = false;
    });
}

/**
 * 淘汰一轮：帧目录按目录算一份，source 按文件算一份，一起从最旧的开始删。
 *
 * 刚下载的 source 不进候选、也不计入总量：它可能正被 ffmpeg 读着，把它算进总量只会让帧图白删一遍。
 */
export async function pruneCache(root: string, limitBytes: number): Promise<void> {
  const now = Date.now();
  const entries: CacheFile[] = [
    ...(await listFrameDirs(root)),
    ...(await listSources(root)).filter((source) => now - source.mtimeMs >= SOURCE_MIN_AGE_MS),
  ];

  let total = entries.reduce((sum, entry) => sum + entry.bytes, 0);
  if (total <= limitBytes) return;

  entries.sort((left, right) => left.mtimeMs - right.mtimeMs);
  for (const entry of entries) {
    if (total <= limitBytes) break;
    await rm(entry.path, { recursive: true, force: true }).catch(() => undefined);
    total -= entry.bytes;
  }
}

/** 每个视频的帧目录算一项，mtime 取目录内最新的那张图。 */
async function listFrameDirs(root: string): Promise<CacheFile[]> {
  const dir = join(root, 'frames');
  const keys = await readdir(dir).catch(() => [] as string[]);
  const entries: CacheFile[] = [];

  for (const key of keys) {
    const frameDir = join(dir, key);
    const names = await readdir(frameDir).catch(() => [] as string[]);
    let bytes = 0;
    let mtimeMs = 0;
    for (const name of names) {
      const info = await stat(join(frameDir, name)).catch(() => null);
      if (!info?.isFile()) continue;
      bytes += info.size;
      mtimeMs = Math.max(mtimeMs, info.mtimeMs);
    }
    if (bytes > 0) entries.push({ path: frameDir, bytes, mtimeMs });
  }
  return entries;
}

export function defaultCacheRoot(): string {
  return join(resolveMicaHome(), 'plugin-data', 'video');
}

/** 本地路径的 `~` 展开，与 read_image 的写法保持一致。 */
export function expandHome(source: string): string {
  if (source === '~') return homedir();
  if (source.startsWith('~/')) return resolve(homedir(), source.slice(2));
  return source;
}

async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  const runners = new Array(Math.min(limit, items.length)).fill(0).map(async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await worker(items[index]!, index);
    }
  });
  await Promise.all(runners);
  return results;
}

function guessExtension(url: string): string {
  try {
    const pathname = new URL(url).pathname;
    const ext = extname(pathname).toLowerCase();
    if (/^\.(mp4|mov|m4v|webm|mkv|avi)$/.test(ext)) return ext;
  } catch {
    // 落到默认后缀，ffmpeg 会自己判容器。
  }
  return '.mp4';
}

function formatMegaBytes(bytes: number): string {
  return `${Math.round(bytes / 1024 / 1024)} MB`;
}
