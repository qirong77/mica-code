import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { resolveMicaHome } from '@packages/mica-config/brand.js';
import { writeTextFileAtomic } from '@packages/mica-config/atomicWrite.js';

/**
 * `$MICA_HOME/tool-icons.json`：工具图标的只读投影，{ 工具名: emoji }。
 *
 * 为什么需要它：emoji 的事实来源是工具自己的声明（内置工具类里的 `icon`、插件
 * `ctx.tools.register(tool, { icon })`），那份注册表只活在跑 agent 的进程里。终端与它同
 * 进程，直接查即可；桌面渲染层在另一个进程，还得能画**没有启动会话的历史消息**——所以
 * 装配过插件的宿主把注册表投影成这份文件，桌面读它。
 *
 * 与 `plugin-status.json` 的区别：那份记「装没装上」，这份只记「长什么样」，所以内容
 * 稳定得多，只在工具集合变化时重写（`writeToolIconCatalog()` 会先比对再落盘）。
 */
export const TOOL_ICON_CATALOG_FILE = 'tool-icons.json';

export type ToolIconCatalog = Record<string, string>;

export function toolIconCatalogPath(configDir: string = resolveMicaHome()): string {
  return join(configDir, TOOL_ICON_CATALOG_FILE);
}

/** 上一次写盘的内容，按路径记：同一份内容重复写没有意义。 */
const lastWritten = new Map<string, string>();

/**
 * 读投影。文件不存在（还没跑过装配插件的宿主）或内容坏掉时返回空表——界面据此回落到
 * `DEFAULT_TOOL_ICON`，不该因为一份缓存文件把工具行整块弄崩。
 */
export function readToolIconCatalog(configDir: string = resolveMicaHome()): ToolIconCatalog {
  try {
    const parsed = JSON.parse(readFileSync(toolIconCatalogPath(configDir), 'utf-8')) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const icons: ToolIconCatalog = {};
    for (const [name, icon] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof icon !== 'string' || !icon.trim()) continue;
      icons[name] = icon.trim();
    }
    return icons;
  } catch {
    return {};
  }
}

/** 写投影；内容与上一次相同就跳过。返回是否真的落了盘。 */
export function writeToolIconCatalog(
  icons: ToolIconCatalog,
  configDir: string = resolveMicaHome(),
): boolean {
  const path = toolIconCatalogPath(configDir);
  const body = `${JSON.stringify(icons, null, 2)}\n`;
  if (lastWritten.get(path) === body) return false;
  try {
    writeTextFileAtomic(path, body);
    lastWritten.set(path, body);
    return true;
  } catch {
    // 投影只是给界面画图标用的：写不进去不该影响工具运行，界面上顶多回落默认图标。
    return false;
  }
}

/** 测试用：让「上次写了什么」跟着临时目录一起重置。 */
export function resetToolIconCatalogCache(): void {
  lastWritten.clear();
}
