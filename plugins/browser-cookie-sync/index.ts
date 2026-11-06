import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolveMicaHome } from '@packages/mica-config/index.js';
import type { PluginContext } from '@packages/mica-plugin/index.js';
import { startCookieService } from './service.js';
import { updatePluginData } from './status.js';
import { extensionAssets, extensionFiles, extensionFingerprint, extensionVersion } from './extensionSources.js';

const PORT = 19387;

function serviceToken(dataDir: string): string {
  mkdirSync(dataDir, { recursive: true });
  const file = join(dataDir, 'token');
  try {
    const token = readFileSync(file, 'utf8').trim();
    if (token.length >= 32) return token;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const generated = randomBytes(32).toString('hex');
  try {
    writeFileSync(file, generated, { flag: 'wx', mode: 0o600 });
    return generated;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      const existing = readFileSync(file, 'utf8').trim();
      if (existing.length >= 32) return existing;
    }
    throw error;
  }
}

export type ExtensionInfo = { dir: string; version: string; fingerprint: string; updatedAt: number };

/** 磁盘上的扩展与「上次写入」记录。指纹用来判断是否需要重写，避免每次启动都刷 mtime。 */
type ExtensionMeta = { version: string; fingerprint: string; updatedAt: number };

function readMeta(file: string): ExtensionMeta | null {
  try {
    const meta = JSON.parse(readFileSync(file, 'utf8')) as ExtensionMeta;
    if (typeof meta?.fingerprint === 'string' && typeof meta.updatedAt === 'number') return meta;
  } catch {
    // 没有记录，或记录坏了：当作首次安装。
  }
  return null;
}

/**
 * 把内嵌进二进制的扩展同步到磁盘。每次插件加载都跑一次：Mica 升级后内嵌资源变新，
 * 磁盘上的副本跟着换掉，用户不需要在 chrome://extensions 里删了重装。
 *
 * 只有内容真的变了（或文件被删/被改）才重写，`updatedAt` 也只在那一刻推进——
 * 它表示「这份扩展最近一次被更新是什么时候」，不能每次启动都变成当前时间。
 */
function syncExtension(dataDir: string): ExtensionInfo {
  const target = join(dataDir, 'extension-v2');
  const metaFile = join(dataDir, 'extension-meta.json');
  const meta = readMeta(metaFile);
  const expected: Array<[string, Buffer]> = Object.entries(extensionFiles).map(([name, content]) => [
    name,
    Buffer.from(content),
  ]);
  for (const [name, base64] of Object.entries(extensionAssets)) expected.push([name, Buffer.from(base64, 'base64')]);
  const outdated =
    meta?.fingerprint !== extensionFingerprint ||
    expected.some(([name, bytes]) => {
      try {
        return !readFileSync(join(target, name)).equals(bytes);
      } catch {
        return true;
      }
    });

  let updatedAt = meta?.updatedAt ?? 0;
  if (!meta || outdated) {
    mkdirSync(join(target, 'icons'), { recursive: true });
    for (const [name, bytes] of expected) writeFileSync(join(target, name), bytes, { mode: 0o600 });
    updatedAt = Date.now();
    writeFileSync(
      metaFile,
      `${JSON.stringify({ version: extensionVersion, fingerprint: extensionFingerprint, updatedAt }, null, 2)}\n`,
      { mode: 0o600 },
    );
  }
  return { dir: target, version: extensionVersion, fingerprint: extensionFingerprint, updatedAt };
}

export default function setup(ctx: PluginContext): void {
  const dataDir = join(ctx.paths?.config ?? resolveMicaHome(), 'plugin-data', ctx.pluginId);
  // 插件每次加载都同步一次：Mica 升级后内嵌的扩展资源变新，磁盘上的副本自动跟上，
  // 扩展自己会比对 /health 里的指纹并重载，用户不需要重新「加载已解压的扩展程序」。
  let extension = syncExtension(dataDir);
  ctx.actions?.register('connection', async () => {
    extension = syncExtension(dataDir);
    return {
      message: `Chrome 扩展 v${extension.version}（更新于 ${new Date(extension.updatedAt).toLocaleString()}）目录：${extension.dir}（chrome://extensions → 加载已解压的扩展程序）。在扩展弹窗里粘贴连接口令：${serviceToken(dataDir)}。服务地址：http://127.0.0.1:${PORT}。口令只填到本机扩展，不要发给网站。`,
    };
  });

  if (!process.env.MICA_BROWSER_URL || !ctx.desktop) return;
  let service: Awaited<ReturnType<typeof startCookieService>> | null = null;
  let disposed = false;
  let starting = false;
  const start = async () => {
    if (disposed || starting || service) return;
    starting = true;
    try {
      const started = await startCookieService({
        port: PORT,
        token: serviceToken(dataDir),
        micaBrowserUrl: process.env.MICA_BROWSER_URL!,
        extensionInfo: () => extension,
        onClientCount: (count) => updatePluginData(dataDir, { target: { text: count > 0 ? '已连接' : '等待 Chrome' } }),
      });
      if (disposed) {
        await started.close();
        return;
      }
      service = started;
      updatePluginData(dataDir, { target: { text: '等待 Chrome' } });
      ctx.health.clear();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EADDRINUSE') {
        updatePluginData(dataDir, { target: { text: '服务启动失败', tone: 'error' } });
        ctx.health.report({
          level: 'error',
          message: `Cookie 服务启动失败：${error instanceof Error ? error.message : String(error)}`,
        });
      }
    } finally {
      starting = false;
    }
  };
  void start();
  ctx.background?.register({ id: 'service-owner', every: 15_000, run: start });
  ctx.onDispose(async () => {
    disposed = true;
    await service?.close();
    if (service) updatePluginData(dataDir, { target: { text: '服务已停止' } });
  });
}
