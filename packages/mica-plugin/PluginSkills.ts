import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolveMicaHome } from '@packages/mica-config/brand.js';
import type { Skill } from '@packages/mica-skills/types.js';
import { PLUGIN_STATE_FILE, readDisabledPluginIds } from './PluginState.js';

/**
 * 内置 skill 的磁盘索引：`$MICA_HOME/plugin-skills/<pluginId>.json`。
 *
 * 插件注册的 skill 只活在跑插件的那个进程里（会话 app-server / TUI），而「列出可用能力」
 * 的宿主往往不是它——桌面运行时给输入框做 `/` 补全时不能为了两个名字去冷启动一个会话
 * 进程。所以在插件注册时顺带落一份索引：写的是注册成功、真正生效的那几条，读的人只是
 * 扫描，不 setup 任何插件。
 *
 * 一个插件一份文件，不做全局合并：多个进程（TUI、每会话一个 app-server）会各写一遍，
 * 只要各写各的 id 就不会互相覆盖。
 */

export const PLUGIN_SKILLS_DIR = 'plugin-skills';

const INDEX_VERSION = 1;
const MAX_SKILLS = 200;

export type PublishedPluginSkill = {
  pluginId: string;
  name: string;
  description: string;
  /** `SKILL.md` 的绝对路径：补全插入的就是它，模型据此读全文。 */
  path: string;
};

type PluginSkillsOptions = {
  /** `$MICA_HOME`；省略时按品牌默认目录解析。 */
  configDir?: string;
};

export function resolvePluginSkillsDir(options: PluginSkillsOptions = {}): string {
  return join(options.configDir || resolveMicaHome(), PLUGIN_SKILLS_DIR);
}

/**
 * 插件 id 允许 `user.` 前缀与点号，但不允许路径分隔符；开头的点要削掉，否则文件名
 * 变成隐藏文件，扫描时按临时文件跳过。
 */
function indexFileName(pluginId: string): string {
  const safe = pluginId
    .trim()
    .replace(/[^A-Za-z0-9._-]/g, '_')
    .replace(/^\.+/, '');
  return safe ? `${safe}.json` : '';
}

/**
 * 写入某个插件的内置 skill 索引。
 *
 * 传空列表等于删除：插件把 skill 摘干净了，索引也不该留着一份谁都不知道的旧名字。
 * 返回索引路径（没写成返回 null）。
 */
export function publishPluginSkills(
  pluginId: string,
  skills: Skill[],
  options: PluginSkillsOptions = {},
): string | null {
  const fileName = indexFileName(pluginId);
  if (!fileName) return null;
  const dir = resolvePluginSkillsDir(options);
  const path = join(dir, fileName);

  const entries = new Map<string, { name: string; description: string; path: string }>();
  for (const skill of skills) {
    const name = String(skill?.name ?? '').trim();
    if (!name || entries.has(name)) continue;
    // 正文必须落盘：补全插入的是 `SKILL.md` 的绝对路径，插件只把内容放在内存里
    // 的话读不到文件，列出来反而误导。
    const skillPath = join(skill.baseDir, 'SKILL.md');
    if (!existsSync(skillPath)) continue;
    entries.set(name, {
      name,
      description: String(skill.description ?? '').trim(),
      path: skillPath,
    });
    if (entries.size >= MAX_SKILLS) break;
  }

  if (entries.size === 0) {
    rmSync(path, { force: true });
    return null;
  }

  const payload = {
    version: INDEX_VERSION,
    pluginId: pluginId.trim(),
    skills: [...entries.values()],
  };
  try {
    mkdirSync(dir, { recursive: true });
    // 同目录临时文件再改名：读的一方（另一个进程）永远看不到半份 JSON。
    const temporary = join(dir, `.${fileName}.${process.pid}.tmp`);
    writeFileSync(temporary, `${JSON.stringify(payload, null, 2)}\n`, 'utf-8');
    renameSync(temporary, path);
  } catch {
    return null;
  }
  return path;
}

/**
 * 扫描全部插件发布的内置 skill。
 *
 * 读的时候才过滤，写的时候不清理，因为「哪个插件停用了」是随时会变的状态，而索引文件
 * 只在那个插件被 setup 时才刷新：停用后没人再写它，只能靠这里按 `plugins-state.json`
 * 剔除。正文文件已不存在的条目同样丢掉（插件被删掉时不会有人来删它的索引）。
 */
export function readPublishedPluginSkills(options: PluginSkillsOptions = {}): PublishedPluginSkill[] {
  const dir = resolvePluginSkillsDir(options);
  if (!existsSync(dir)) return [];

  const configDir = options.configDir || resolveMicaHome();
  const disabled = readDisabledPluginIds({ path: join(configDir, PLUGIN_STATE_FILE) });
  const skills: PublishedPluginSkill[] = [];
  const seen = new Set<string>();

  let files: string[] = [];
  try {
    files = readdirSync(dir);
  } catch {
    return [];
  }

  for (const file of files.sort()) {
    if (!file.endsWith('.json') || file.startsWith('.')) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(join(dir, file), 'utf-8'));
    } catch {
      continue;
    }
    if (!isRecord(parsed) || !Array.isArray(parsed.skills)) continue;
    const pluginId = typeof parsed.pluginId === 'string' ? parsed.pluginId.trim() : '';
    if (!pluginId || disabled.has(pluginId)) continue;

    for (const entry of parsed.skills) {
      if (!isRecord(entry)) continue;
      const name = typeof entry.name === 'string' ? entry.name.trim() : '';
      const path = typeof entry.path === 'string' ? entry.path : '';
      if (!name || !path || seen.has(name) || !existsSync(path)) continue;
      seen.add(name);
      skills.push({
        pluginId,
        name,
        description: typeof entry.description === 'string' ? entry.description : '',
        path,
      });
    }
  }

  return skills.sort((left, right) => left.name.localeCompare(right.name));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
