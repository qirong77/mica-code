import { randomUUID } from 'node:crypto';
import {
  closeSync,
  fchmodSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import type { PromptControls } from '@packages/mica-common/promptControls.js';
import { resolveMicaHome } from './brand.js';

const MAX_FILE_BYTES = 1024 * 1024;
const MAX_SECTION_CHARACTERS = 200_000;
const MAX_ENTRIES = 1000;
const BASE_SECTIONS = new Set(['role', 'project-instructions', 'skills', 'context']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
  );
}

function fail(message: string): never {
  throw new Error(`Invalid prompt controls: ${message}`);
}

function validId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 512 &&
    value.trim() === value &&
    !/[\u0000-\u001f\u007f]/.test(value)
  );
}

/** Validate the whole request before replacing any existing controls. */
export function normalizePromptControls(value: unknown): PromptControls {
  if (!isRecord(value)) fail('expected an object');
  if (value.version !== 1) fail('version must be 1');
  if (Object.keys(value).some((key) => !['version', 'disabledPlugins', 'sections'].includes(key))) {
    fail('unknown field');
  }
  if (!Array.isArray(value.disabledPlugins) || value.disabledPlugins.length > MAX_ENTRIES) {
    fail('disabledPlugins must be an array with at most 1000 entries');
  }
  if (!value.disabledPlugins.every(validId)) fail('disabledPlugins must contain valid plugin ids');
  if (!isRecord(value.sections)) fail('sections must be an object');
  const entries = Object.entries(value.sections);
  if (entries.length > MAX_ENTRIES) fail('too many sections');
  const sections: PromptControls['sections'] = {};
  for (const [id, section] of entries) {
    if (id === 'system') fail('system is read-only');
    if (!validId(id) || (!BASE_SECTIONS.has(id) && !/^plugin:[^/]+\/.+$/.test(id))) fail(`invalid section id: ${id}`);
    if (!isRecord(section)) fail(`${id} must be an object`);
    if (Object.keys(section).some((key) => key !== 'enabled' && key !== 'content')) fail(`${id} has an unknown field`);
    if ('enabled' in section && typeof section.enabled !== 'boolean') fail(`${id}.enabled must be a boolean`);
    if ('content' in section && typeof section.content !== 'string') fail(`${id}.content must be a string`);
    if (typeof section.content === 'string' && section.content.length > MAX_SECTION_CHARACTERS) {
      fail(`${id}.content exceeds 200000 characters`);
    }
    sections[id] = {
      ...(typeof section.enabled === 'boolean' ? { enabled: section.enabled } : {}),
      ...(typeof section.content === 'string' ? { content: section.content } : {}),
    };
  }
  const controls: PromptControls = { version: 1, disabledPlugins: [...new Set(value.disabledPlugins)], sections };
  if (Buffer.byteLength(JSON.stringify(controls), 'utf8') > MAX_FILE_BYTES) fail('document exceeds 1 MB');
  return controls;
}

export function readPromptControls(): PromptControls {
  const path = join(resolveMicaHome(), 'prompt-controls.json');
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, disabledPlugins: [], sections: {} };
    throw error;
  }
  if (Buffer.byteLength(text, 'utf8') > MAX_FILE_BYTES) fail('document exceeds 1 MB');
  try {
    return normalizePromptControls(JSON.parse(text));
  } catch (error) {
    throw new Error(`Cannot read ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export function writePromptControls(value: unknown): PromptControls {
  const controls = normalizePromptControls(value);
  const text = `${JSON.stringify(controls)}\n`;
  if (Buffer.byteLength(text, 'utf8') > MAX_FILE_BYTES) fail('document exceeds 1 MB');
  const directory = resolveMicaHome();
  mkdirSync(directory, { recursive: true });
  const path = join(directory, 'prompt-controls.json');
  const temporary = join(directory, `.prompt-controls.${randomUUID()}.tmp`);
  let fd: number | undefined;
  try {
    fd = openSync(temporary, 'wx', 0o600);
    fchmodSync(fd, 0o600);
    writeFileSync(fd, text, 'utf8');
    closeSync(fd);
    fd = undefined;
    renameSync(temporary, path);
  } finally {
    if (fd !== undefined) closeSync(fd);
    try {
      unlinkSync(temporary);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  return controls;
}
