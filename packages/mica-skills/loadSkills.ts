import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { homedir } from 'node:os';
import { resolveMicaHome } from '@packages/mica-config/brand.js';
import type { Disposable } from '@packages/mica-common/index.js';
import type { Skill } from './types.js';

function getSkillsDirs(): string[] {
  const micaHome = resolveMicaHome();
  const cwd = process.cwd();
  return [
    join(cwd, '.mica', 'skills'),
    join(cwd, '.agents', 'skills'),
    join(cwd, '.deveco', 'skills'),
    join(cwd, '.agent_context', 'skills'),
    join(micaHome, 'skills'),
    ...(process.env.MICA_HOME
      ? []
      : [join(homedir(), '.agents', 'skills'), join(homedir(), '.config', 'deveco', 'skills')]),
  ];
}

function parseFrontmatter(raw: string): { frontmatter: Record<string, unknown>; content: string } {
  const trimmed = raw.trimStart();
  if (!trimmed.startsWith('---')) {
    return { frontmatter: {}, content: raw };
  }

  const secondNewline = trimmed.indexOf('\n', 3);
  if (secondNewline === -1) {
    return { frontmatter: {}, content: raw };
  }

  const endMarker = trimmed.indexOf('\n---', secondNewline);
  if (endMarker === -1) {
    return { frontmatter: {}, content: raw };
  }

  const fmText = trimmed.slice(4, endMarker).trim();
  const body = trimmed.slice(endMarker + 4).trimStart();
  const frontmatter: Record<string, unknown> = {};

  let currentKey = '';
  let currentList: string[] = [];
  let inList = false;

  for (const rawLine of fmText.split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;

    const listMatch = line.match(/^\s*-\s+(.*)$/);
    if (listMatch) {
      if (currentKey) {
        currentList.push(listMatch[1].trim());
        inList = true;
      }
      continue;
    }

    if (inList && currentKey) {
      frontmatter[currentKey] = currentList;
      currentList = [];
      inList = false;
    }

    const kvMatch = line.match(/^([a-zA-Z_-][a-zA-Z0-9_-]*)\s*:\s*(.*)$/);
    if (!kvMatch) continue;

    currentKey = kvMatch[1];
    const value = kvMatch[2].trim();

    if (value === '') {
      frontmatter[currentKey] = value;
      currentList = [];
      continue;
    }

    if (value === 'true') {
      frontmatter[currentKey] = true;
      continue;
    }

    if (value === 'false') {
      frontmatter[currentKey] = false;
      continue;
    }

    const quoted = value.match(/^["'](.*)["']$/);
    frontmatter[currentKey] = quoted ? quoted[1] : value;
  }

  if (inList && currentKey) {
    frontmatter[currentKey] = currentList;
  }

  return { frontmatter, content: body };
}

/** 一份 SKILL.md 解析出来的东西：frontmatter 元数据 + 正文。 */
export type ParsedSkillMarkdown = {
  name?: string;
  description?: string;
  whenToUse?: string;
  argumentHint?: string;
  content: string;
};

/**
 * 解析 SKILL.md 正文。
 *
 * 插件把 skill 随包分发（正文用 text import 内嵌）时，元数据只有一份来源——frontmatter。
 * 否则清单、注册调用与文件里的描述会各写一遍，迟早不一致。
 */
export function parseSkillMarkdown(raw: string): ParsedSkillMarkdown {
  const { frontmatter, content } = parseFrontmatter(raw);
  const name = formatFrontmatterValue(frontmatter.name);
  const description = formatFrontmatterValue(frontmatter.description);
  return {
    name: name || undefined,
    description: description || undefined,
    whenToUse: formatFrontmatterValue(frontmatter.when_to_use),
    argumentHint: formatFrontmatterValue(frontmatter['argument-hint']),
    content,
  };
}

/**
 * 读一个 skill 目录。`name` 只作 frontmatter 没写 name 时的兜底，省略就用目录名。
 *
 * 插件把自己的 skill 放在插件目录里随包分发时，宿主也用这一份实现读它——解析规则
 * 只有一处，插件不必自己拼 frontmatter。
 */
export function loadSkillFromDir(skillDir: string, name?: string): Skill | null {
  const skillFilePath = join(skillDir, 'SKILL.md');
  if (!existsSync(skillFilePath)) return null;
  const fallback = name || basename(skillDir);

  try {
    const parsed = parseSkillMarkdown(readFileSync(skillFilePath, 'utf-8'));
    return {
      name: parsed.name || fallback,
      description: parsed.description || fallback,
      whenToUse: parsed.whenToUse,
      argumentHint: parsed.argumentHint,
      content: parsed.content,
      baseDir: skillDir,
    };
  } catch {
    return null;
  }
}

function formatFrontmatterValue(value: unknown): string | undefined {
  if (typeof value === 'string') return value || undefined;
  if (Array.isArray(value)) {
    const items = value.map((item) => String(item).trim()).filter(Boolean);
    return items.length > 0 ? items.join('; ') : undefined;
  }
  if (value === undefined || value === null) return undefined;
  return String(value);
}

let diskSkills: Skill[] | null = null;
let composedSkills: Skill[] | null = null;

/**
 * 运行期注册的 skill（插件提供的内置能力），按 owner 分组。
 *
 * 磁盘上的 skill 是用户的资产，插件注册的是产品的内置能力：同名时**磁盘优先**，
 * 这样用户装一份同名 skill 就能覆盖内置实现，而插件不会悄悄抢走用户的名字。
 * 冲突结果通过 `registerRuntimeSkills` 的返回值报告，插件据此上报健康状态。
 */
const runtimeSkills = new Map<string, Skill[]>();

function scanDiskSkills(): Skill[] {
  const skills: Skill[] = [];
  const seen = new Set<string>();

  for (const skillsDir of getSkillsDirs()) {
    if (!existsSync(skillsDir) || !statSync(skillsDir).isDirectory()) {
      continue;
    }

    try {
      for (const entry of readdirSync(skillsDir)) {
        if (seen.has(entry)) continue;
        const fullPath = join(skillsDir, entry);
        if (!statSync(fullPath).isDirectory()) continue;
        const skill = loadSkillFromDir(fullPath, entry);
        if (!skill) continue;
        skills.push(skill);
        seen.add(entry);
      }
    } catch {
      // Ignore invalid skills directories.
    }
  }

  return skills;
}

function diskSkillList(): Skill[] {
  if (diskSkills === null) diskSkills = scanDiskSkills();
  return diskSkills;
}

function composeSkills(): Skill[] {
  const skills = [...diskSkillList()];
  const taken = new Set(skills.map((skill) => skill.name));
  for (const owned of runtimeSkills.values()) {
    for (const skill of owned) {
      // 注册时的冲突已经报过，这里只保证合流结果不出现重名。
      if (taken.has(skill.name)) continue;
      taken.add(skill.name);
      skills.push(skill);
    }
  }
  return skills;
}

export function getLoadedSkills(): Skill[] {
  if (composedSkills === null) composedSkills = composeSkills();
  return composedSkills;
}

export function reloadSkills(): Skill[] {
  diskSkills = null;
  composedSkills = null;
  return getLoadedSkills();
}

export type RuntimeSkillRegistration = Disposable & {
  /** 因为重名没注册上的 skill，插件应当把它当成一条用户可见的状态。 */
  skipped: { name: string; reason: string }[];
};

/**
 * 注册一组运行期 skill，归属到 `owner`（插件用它自己的 pluginId）。
 *
 * 与磁盘扫描的差别只有一点：这些 skill 不在任何目录里，随宿主的生命周期出现与消失。
 * 调用方负责在插件卸载时 `dispose()`。
 */
export function registerRuntimeSkills(owner: string, skills: Skill[]): RuntimeSkillRegistration {
  const existing = runtimeSkills.get(owner) ?? [];
  const taken = new Set([...diskSkillList().map((skill) => skill.name), ...existing.map((skill) => skill.name)]);
  const accepted: Skill[] = [];
  const skipped: { name: string; reason: string }[] = [];

  for (const skill of skills) {
    const name = skill.name.trim();
    if (!name) {
      skipped.push({ name: '', reason: 'skill 缺少 name' });
      continue;
    }
    if (taken.has(name)) {
      skipped.push({ name, reason: '同名 skill 已存在（磁盘上的 skill 优先）' });
      continue;
    }
    taken.add(name);
    accepted.push({ ...skill, name });
  }

  if (accepted.length > 0) {
    runtimeSkills.set(owner, [...existing, ...accepted]);
    composedSkills = null;
  }

  let disposed = false;
  return {
    skipped,
    dispose() {
      // 幂等：重复 dispose 不得把后来重新注册的同名 skill 一起摘掉。
      if (disposed) return;
      disposed = true;
      const current = runtimeSkills.get(owner);
      if (!current) return;
      const remaining = current.filter((skill) => !accepted.includes(skill));
      if (remaining.length > 0) runtimeSkills.set(owner, remaining);
      else runtimeSkills.delete(owner);
      composedSkills = null;
    },
  };
}

/** 摘掉某个 owner 的全部运行期 skill（插件卸载的兜底）。 */
export function clearRuntimeSkills(owner: string): void {
  if (!runtimeSkills.delete(owner)) return;
  composedSkills = null;
}
