import { readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, extname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { CONFIG_DIR_NAME } from '@packages/mica-config/brand.js';
import type { MicaPlugin } from './Plugin.js';

export type FilePluginLoaderOptions = {
  homeDir?: string;
  pluginsDir?: string;
  logger?: {
    warn(event: string, data?: unknown): void;
  };
};

export type FilePluginLoadResult = {
  plugins: MicaPlugin[];
  loaded: { pluginId: string; file: string }[];
  failed: { file: string; error: unknown }[];
};

export async function loadFilePlugins(options: FilePluginLoaderOptions = {}): Promise<FilePluginLoadResult> {
  const pluginsDir = options.pluginsDir ?? join(options.homeDir ?? homedir(), CONFIG_DIR_NAME, 'plugins');
  const result: FilePluginLoadResult = { plugins: [], loaded: [], failed: [] };
  let entries: string[];

  try {
    entries = await readdir(pluginsDir);
  } catch (error) {
    if (isMissingDirectory(error)) return result;
    throw error;
  }

  for (const fileName of entries.filter(isPluginFile).sort()) {
    const file = join(pluginsDir, fileName);
    try {
      const plugin = await loadFilePlugin(file);
      result.plugins.push(plugin);
      result.loaded.push({ pluginId: plugin.id, file });
    } catch (error) {
      result.failed.push({ file, error });
      options.logger?.warn('file-plugin:load-failed', { file, error: formatError(error) });
    }
  }

  return result;
}

async function loadFilePlugin(file: string): Promise<MicaPlugin> {
  const mod = await import(pathToFileURL(file).href);
  const setup = resolvePluginFactory(mod);
  const id = basename(file, extname(file));
  return {
    id: `file.${id}`,
    name: id,
    setup,
  };
}

function resolvePluginFactory(mod: unknown): MicaPlugin['setup'] {
  if (typeof mod === 'object' && mod !== null && 'default' in mod && typeof mod.default === 'function') {
    return mod.default as MicaPlugin['setup'];
  }
  throw new Error('Plugin file must default export a setup function');
}

function isPluginFile(fileName: string): boolean {
  return fileName.endsWith('.mjs') || fileName.endsWith('.js');
}

function isMissingDirectory(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
