import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolveMicaHome } from '@packages/mica-config/index.js';
import type { PluginContext } from '@packages/mica-plugin/index.js';
import { startCookieService } from './service.js';
import { updatePluginData } from './status.js';
import { extensionFiles } from './extensionSources.js';

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

function installExtension(dataDir: string): string {
  const target = join(dataDir, 'extension-v2');
  mkdirSync(target, { recursive: true });
  for (const [name, content] of Object.entries(extensionFiles)) {
    writeFileSync(join(target, name), content, { mode: 0o600 });
  }
  return target;
}

export default function setup(ctx: PluginContext): void {
  const dataDir = join(ctx.paths?.config ?? resolveMicaHome(), 'plugin-data', ctx.pluginId);
  ctx.actions?.register('connection', async () => ({
    message: `Chrome 扩展目录：${installExtension(dataDir)}（chrome://extensions → 加载已解压的扩展程序）。在扩展选项中粘贴连接口令：${serviceToken(dataDir)}。服务地址：http://127.0.0.1:${PORT}。口令只填到本机扩展，不要发给网站。`,
  }));

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
