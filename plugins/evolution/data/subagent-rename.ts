import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { acquireProcessLock } from '@packages/mica-common/processLock.js';
import { writeTextFileAtomic } from '@packages/mica-config/atomicWrite.js';
import { normalizePromptControls } from '@packages/mica-config/promptControls.js';
import {
  renamePluginIdList,
  renameSectionId,
  renameSkillNameList,
  renameToolNameList,
} from '../pluginRenames.js';
import { archivePrivateOriginal } from './private-files.js';
import type { DataMigration } from './types.js';

/**
 * 插件改名之后，把 `$MICA_HOME` 下按**插件 id 命名**的数据搬到新名字上。
 *
 * 为什么要一个一次性的标记文件（而不是像别的数据迁移那样每次启动都跑一遍）：这次改名
 * 两头撞在同一个名字上——`sidecar` 变成 `subagent`，而旧的 `subagent` 变成
 * `subagent-legacy`。搬完之后磁盘上的 `subagent` 已经是新插件的名字，再跑一遍就会把它
 * 当成旧名字继续改成 `subagent-legacy`。所以这条迁移只允许成功执行一次，执行完写
 * `plugin-data/evolution/subagent-rename.json`。中途被别的进程占着锁的步骤不写标记，
 * 下次启动继续（每一步都以「旧的还在、新的没被偷换」为前提，重复执行没有副作用）。
 *
 * 搬的东西：
 * - `plugin-settings/<id>.json`：插件设置（停滞分钟、委派倾向……）。旧 `subagent.json`
 *   先让位给 `subagent-legacy.json`，`sidecar.json` 才能落到 `subagent.json`。
 * - `plugins-state.json`：启停名单。
 * - `prompt-controls.json`：`disabledPlugins`、`plugin:<id>/<section>` 段键与段落顺序。
 * - `config.json` 的 `capabilityDefaults`：新会话默认停用的工具 / 技能名。
 * - `sidecar/`：随包 skill 的落盘目录（派生数据，挪过去就不必再生成一遍）。
 * - `plugin-skills/sidecar.json`：skill 索引（派生数据，原样归档后删掉，宿主会重新发布）。
 */
const MARKER = join('plugin-data', 'evolution', 'subagent-rename.json');

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function readRecord(path: string): { text: string; value: Record<string, unknown> } | null {
  try {
    if (!lstatSync(path).isFile()) return null;
    const text = readFileSync(path, 'utf8');
    const value: unknown = JSON.parse(text);
    return isRecord(value) ? { text, value } : null;
  } catch {
    // 坏文件有它自己的报错路径（配置页会显式报错），迁移不覆盖它。
    return null;
  }
}

/**
 * 把一个插件设置文件挪到新 id 上。
 *
 * 目标已存在时不覆盖：两份设置都留着，源文件先原样归档。覆盖会悄悄丢掉用户在这一侧
 * 调过的值，而多留一份归档只是多一个文件。
 */
function moveSettingsFile(home: string, from: string, to: string): number {
  const directory = join(home, 'plugin-settings');
  const source = join(directory, `${from}.json`);
  if (!existsSync(source)) return 0;
  const target = join(directory, `${to}.json`);
  if (!existsSync(target)) {
    mkdirSync(directory, { recursive: true });
    renameSync(source, target);
    return 1;
  }
  archivePrivateOriginal(home, 'legacy-subagent-settings', `${from}-settings`, readFileSync(source));
  rmSync(source, { force: true });
  return 1;
}

/** 就地改一份提示词控制的键；改过才归档原文并写回归一化后的整份。 */
function remapPromptControls(home: string): number {
  const path = join(home, 'prompt-controls.json');
  // 没有这份文件就不必占锁：锁会顺手建出 `.lock.owners`，新机器上不该多出这些。
  if (!existsSync(path)) return 0;
  const release = acquireProcessLock(`${path}.lock`);
  if (!release) return -1;
  try {
    const record = readRecord(path);
    if (!record) return 0;
    try {
      normalizePromptControls(record.value);
    } catch {
      return 0;
    }
    const controls = record.value;
    let changed = 0;
    if (isRecord(controls.sections)) {
      const sections = controls.sections;
      const next: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(sections)) {
        const renamed = renameSectionId(key);
        if (renamed !== key) changed += 1;
        next[renamed] = value;
      }
      if (changed > 0) {
        for (const key of Object.keys(sections)) delete sections[key];
        Object.assign(sections, next);
      }
    }
    if (Array.isArray(controls.disabledPlugins)) changed += renamePluginIdList(controls.disabledPlugins);
    if (Array.isArray(controls.order)) {
      const next = controls.order.map((id) => (typeof id === 'string' ? renameSectionId(id) : id));
      if (JSON.stringify(next) !== JSON.stringify(controls.order)) {
        controls.order = next;
        changed += 1;
      }
    }
    if (changed === 0) return 0;
    archivePrivateOriginal(
      home,
      'legacy-prompt-controls',
      'sidecar-rename',
      Buffer.from(record.text, 'utf8'),
    );
    writeTextFileAtomic(path, `${JSON.stringify(normalizePromptControls(controls), null, 2)}\n`);
    return changed;
  } finally {
    release();
  }
}

/** 新会话默认能力里存的是工具名与技能名，跟着改名走。 */
function remapCapabilityDefaults(home: string): number {
  const path = join(home, 'config.json');
  if (!existsSync(path)) return 0;
  const release = acquireProcessLock(`${path}.lock`);
  if (!release) return -1;
  try {
    const record = readRecord(path);
    if (!record) return 0;
    const defaults = record.value.capabilityDefaults;
    if (!isRecord(defaults)) return 0;
    let changed = 0;
    if (Array.isArray(defaults.disabledTools)) changed += renameToolNameList(defaults.disabledTools);
    if (Array.isArray(defaults.disabledSkills)) changed += renameSkillNameList(defaults.disabledSkills);
    if (changed === 0) return 0;
    writeTextFileAtomic(path, `${JSON.stringify(record.value, null, 2)}\n`);
    return changed;
  } finally {
    release();
  }
}

/** 启停名单：`disabled: ['sidecar']` 之类的旧 id 换成新 id。 */
function remapPluginState(home: string): number {
  const path = join(home, 'plugins-state.json');
  if (!existsSync(path)) return 0;
  const release = acquireProcessLock(`${path}.lock`);
  if (!release) return -1;
  try {
    const record = readRecord(path);
    if (!record || !Array.isArray(record.value.disabled)) return 0;
    const changed = renamePluginIdList(record.value.disabled);
    if (changed === 0) return 0;
    writeTextFileAtomic(path, `${JSON.stringify(record.value, null, 2)}\n`);
    return changed;
  } finally {
    release();
  }
}

/** 随包 skill 的落盘目录跟着插件 id 走：`$MICA_HOME/sidecar/` → `$MICA_HOME/subagent/`。 */
function moveSkillDir(home: string): number {
  const source = join(home, 'sidecar');
  const target = join(home, 'subagent');
  if (!existsSync(source)) return 0;
  if (existsSync(target)) return 0;
  try {
    if (!lstatSync(source).isDirectory()) return 0;
  } catch {
    return 0;
  }
  renameSync(source, target);
  return 1;
}

/** skill 索引是宿主写的派生文件：旧 id 那份归档后删掉，宿主会用新 id 重新发布。 */
function retireSkillIndex(home: string): number {
  const path = join(home, 'plugin-skills', 'sidecar.json');
  if (!existsSync(path)) return 0;
  archivePrivateOriginal(home, 'legacy-subagent-skill', 'sidecar-index', readFileSync(path));
  rmSync(path, { force: true });
  return 1;
}

function writeMarker(home: string, steps: string[]): void {
  const path = join(home, MARKER);
  mkdirSync(join(home, 'plugin-data', 'evolution'), { recursive: true, mode: 0o700 });
  writeTextFileAtomic(path, `${JSON.stringify({ version: 1, at: new Date().toISOString(), steps }, null, 2)}\n`);
}

export const subagentRename: DataMigration = {
  id: 'subagent-rename',
  description:
    '把 sidecar / subagent 两个插件改名后的本地数据搬到新 id 上（设置、启停、提示词控制、默认能力、skill 目录）',
  run({ home, log }) {
    if (existsSync(join(home, MARKER))) return 0;
    const steps: string[] = [];
    let changed = 0;
    // 旧 subagent 的设置先让位，sidecar 才能落到 subagent.json。
    for (const [from, to] of [
      ['subagent', 'subagent-legacy'],
      ['sidecar', 'subagent'],
    ] as const) {
      const moved = moveSettingsFile(home, from, to);
      if (moved > 0) {
        changed += moved;
        steps.push(`plugin-settings/${from}.json→${to}.json`);
      }
    }
    for (const [name, apply] of [
      ['plugins-state', remapPluginState],
      ['prompt-controls', remapPromptControls],
      ['capability-defaults', remapCapabilityDefaults],
    ] as const) {
      const done = apply(home);
      if (done < 0) {
        // 另一个进程正在写这份文件：这一步下个宿主启动再来，标记留到那时写。
        log('evolution:subagent-rename-busy', { step: name });
        return changed;
      }
      if (done > 0) {
        changed += done;
        steps.push(name);
      }
    }
    const movedDir = moveSkillDir(home);
    if (movedDir > 0) {
      changed += movedDir;
      steps.push('sidecar/→subagent/');
    }
    const retired = retireSkillIndex(home);
    if (retired > 0) {
      changed += retired;
      steps.push('plugin-skills/sidecar.json');
    }
    writeMarker(home, steps);
    return changed;
  },
};
