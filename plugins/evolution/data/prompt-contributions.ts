import { randomUUID } from 'node:crypto';
import { lstatSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { acquireProcessLock } from '@packages/mica-common/processLock.js';
import { writeTextFileAtomic } from '@packages/mica-config/atomicWrite.js';
import { normalizePromptControls } from '@packages/mica-config/promptControls.js';
import type { DataMigration } from './types.js';

const OLD_HISTORY = 'plugin:builtin.command-memory/guidance';
const HISTORY = 'plugin:memory/history';
const RETIRED = new Set([
  'plugin:builtin.session-autonomy/guidance',
  'plugin:todo/plan',
  'plugin:video/video',
  'plugin:web-search/web-search',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function readRecord(path: string): { text: string; value: Record<string, unknown> } | null {
  try {
    if (!lstatSync(path).isFile()) return null;
    const text = readFileSync(path, 'utf8');
    const value: unknown = JSON.parse(text);
    return isRecord(value) ? { text, value } : null;
  } catch (error) {
    if (error instanceof SyntaxError || (error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

function migrateControls(controls: Record<string, unknown>): boolean {
  try {
    normalizePromptControls(controls);
  } catch {
    return false;
  }
  if (controls.version !== 1 || !isRecord(controls.sections) || !Array.isArray(controls.disabledPlugins)) return false;
  const sections = controls.sections;
  const disabled = controls.disabledPlugins.includes('builtin.command-memory');
  let changed = disabled;
  if ((isRecord(sections[OLD_HISTORY]) || disabled) && !(HISTORY in sections)) {
    sections[HISTORY] = {
      ...(isRecord(sections[OLD_HISTORY]) ? sections[OLD_HISTORY] : {}),
      ...(disabled ? { enabled: false } : {}),
    };
    changed = true;
  }
  for (const id of [OLD_HISTORY, ...RETIRED]) {
    if (!(id in sections)) continue;
    delete sections[id];
    changed = true;
  }
  if (disabled) controls.disabledPlugins = controls.disabledPlugins.filter((id) => id !== 'builtin.command-memory');
  if (Array.isArray(controls.order)) {
    const next = [
      ...new Set(
        controls.order.filter((id) => !RETIRED.has(String(id))).map((id) => (id === OLD_HISTORY ? HISTORY : id)),
      ),
    ];
    if (JSON.stringify(next) !== JSON.stringify(controls.order)) {
      if (next.length) controls.order = next;
      else delete controls.order;
      changed = true;
    }
  }
  return changed;
}

export const promptContributions: DataMigration = {
  id: 'prompt-contributions',
  description: '历史回查控制归到 Memory，归档已撤下的提示词控制和 Schedule skill 索引',
  run({ home }) {
    let changed = 0;
    const controls = join(home, 'prompt-controls.json');
    const releaseControls = acquireProcessLock(`${controls}.lock`);
    if (releaseControls) {
      try {
        const record = readRecord(controls);
        if (record && migrateControls(record.value)) {
          const serialized = `${JSON.stringify(normalizePromptControls(record.value))}\n`;
          if (Buffer.byteLength(serialized, 'utf8') > 1024 * 1024) {
            throw new Error('提示词控制迁移结果超过 1 MiB，原文件已保留');
          }
          const archive = join(home, 'plugin-data', 'evolution', 'legacy-prompt-controls');
          mkdirSync(archive, { recursive: true, mode: 0o700 });
          writeFileSync(join(archive, `${randomUUID()}.json`), record.text, { mode: 0o600, flag: 'wx' });
          writeTextFileAtomic(controls, serialized);
          changed += 1;
        }
      } finally {
        releaseControls();
      }
    }
    const index = join(home, 'plugin-skills', 'schedule.json');
    const release = acquireProcessLock(`${index}.lock`);
    if (!release) return changed;
    try {
      const record = readRecord(index);
      if (record?.value.pluginId !== 'schedule' || record.value.version !== 2 || !Array.isArray(record.value.skills))
        return changed;
      if (!record.value.skills.every((skill) => isRecord(skill) && skill.name === 'schedule')) return changed;
      const archive = join(home, 'plugin-data', 'evolution', 'legacy-schedule-skill');
      mkdirSync(archive, { recursive: true, mode: 0o700 });
      renameSync(index, join(archive, `${randomUUID()}.json`));
      return changed + 1;
    } finally {
      release();
    }
  },
};
