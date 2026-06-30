import { mkdir, readFile, rm, stat, writeFile } from 'fs/promises';
import { dirname, resolve } from 'path';
import { MicaTool } from './MicaTool.js';
import type { ToolExecuteCallbacks } from './MicaTool.js';
import { truncateDisplayText } from './utils/display.js';
import { backupFile } from './utils/fileHistory.js';

const BEGIN_MARKER = '*** Begin Patch';
const END_MARKER = '*** End Patch';
const ADD_FILE_PREFIX = '*** Add File: ';
const UPDATE_FILE_PREFIX = '*** Update File: ';
const DELETE_FILE_PREFIX = '*** Delete File: ';
const MOVE_TO_PREFIX = '*** Move to: ';

const MAX_SUMMARY_CHANGES = 20;

type PatchOperation =
  | { type: 'add'; path: string; lines: string[] }
  | { type: 'delete'; path: string }
  | { type: 'update'; path: string; moveTo?: string; hunks: PatchHunk[] };

type PatchHunk = {
  header: string;
  lines: HunkLine[];
};

type HunkLine =
  | { type: 'context'; text: string }
  | { type: 'remove'; text: string }
  | { type: 'add'; text: string };

type AppliedChange =
  | { type: 'add'; path: string }
  | { type: 'update'; path: string }
  | { type: 'delete'; path: string }
  | { type: 'move'; path: string; moveTo: string };

type LoadedFile = string | null;

export class ToolApplyPatch extends MicaTool {
  constructor() {
    super('apply_patch', '应用 Codex 风格的文件补丁，支持 Add File、Update File、Delete File 和 Move to。', {
      type: 'object' as const,
      properties: {
        patch: {
          type: 'string',
          description: '补丁文本，必须以 *** Begin Patch 开始，以 *** End Patch 结束。',
        },
      },
      required: ['patch'],
    });
  }

  async execute(input: { patch: string }, _callbacks?: ToolExecuteCallbacks): Promise<string> {
    if (!input.patch.trim()) return 'apply_patch 失败：patch 不能为空';

    const operations = parsePatch(input.patch);
    if (operations.length === 0) return 'apply_patch 失败：补丁中没有文件操作';

    const { pendingFiles, changes } = await preparePatchApplication(operations);
    for (const [filePath, content] of pendingFiles) {
      if (content === null) continue;
      await backupFile(filePath);
      await mkdir(dirname(filePath), { recursive: true });
      await writeFile(filePath, content);
    }
    for (const [filePath, content] of pendingFiles) {
      if (content !== null) continue;
      await backupFile(filePath);
      await rm(filePath, { force: true });
    }

    return formatSummary(changes);
  }

  onToolUseDisplayText(input: Record<string, unknown>): string {
    const patch = typeof input.patch === 'string' ? input.patch : '';
    return `apply_patch (${truncateDisplayText(`${patch.length}B`, 12)})`;
  }
}

function parsePatch(patch: string): PatchOperation[] {
  const lines = patch.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  let index = 0;
  while (index < lines.length && lines[index] === '') index++;

  if (lines[index] !== BEGIN_MARKER) {
    throw new Error(`patch 必须以 ${BEGIN_MARKER} 开始`);
  }
  index++;

  const operations: PatchOperation[] = [];
  while (index < lines.length) {
    const line = lines[index]!;
    if (line === END_MARKER) {
      index++;
      ensureOnlyTrailingBlankLines(lines, index);
      return operations;
    }

    if (line.startsWith(ADD_FILE_PREFIX)) {
      const path = parsePath(line, ADD_FILE_PREFIX, index);
      index++;
      const addLines: string[] = [];
      while (index < lines.length && !isOperationBoundary(lines[index]!)) {
        const contentLine = lines[index]!;
        if (!contentLine.startsWith('+')) {
          throw new Error(`Add File ${path} 的内容行必须以 + 开头（第 ${index + 1} 行）`);
        }
        addLines.push(contentLine.slice(1));
        index++;
      }
      operations.push({ type: 'add', path, lines: addLines });
      continue;
    }

    if (line.startsWith(DELETE_FILE_PREFIX)) {
      const path = parsePath(line, DELETE_FILE_PREFIX, index);
      operations.push({ type: 'delete', path });
      index++;
      continue;
    }

    if (line.startsWith(UPDATE_FILE_PREFIX)) {
      const path = parsePath(line, UPDATE_FILE_PREFIX, index);
      index++;
      let moveTo: string | undefined;
      const hunks: PatchHunk[] = [];

      while (index < lines.length && !isOperationBoundary(lines[index]!)) {
        const updateLine = lines[index]!;
        if (updateLine.startsWith(MOVE_TO_PREFIX)) {
          moveTo = parsePath(updateLine, MOVE_TO_PREFIX, index);
          index++;
          continue;
        }

        if (updateLine.startsWith('@@')) {
          const parsed = parseHunk(lines, index);
          hunks.push(parsed.hunk);
          index = parsed.nextIndex;
          continue;
        }

        throw new Error(`Update File ${path} 中存在无法识别的行（第 ${index + 1} 行）：${updateLine}`);
      }

      if (!moveTo && hunks.length === 0) {
        throw new Error(`Update File ${path} 缺少 hunk 或 Move to`);
      }
      operations.push({ type: 'update', path, moveTo, hunks });
      continue;
    }

    if (line === '') {
      index++;
      continue;
    }

    throw new Error(`无法识别的 patch 行（第 ${index + 1} 行）：${line}`);
  }

  throw new Error(`patch 缺少 ${END_MARKER}`);
}

function parsePath(line: string, prefix: string, index: number): string {
  const path = line.slice(prefix.length).trim();
  if (!path) throw new Error(`第 ${index + 1} 行缺少文件路径`);
  return path;
}

function parseHunk(lines: string[], startIndex: number): { hunk: PatchHunk; nextIndex: number } {
  const header = lines[startIndex]!;
  const hunkLines: HunkLine[] = [];
  let hasEdit = false;
  let index = startIndex + 1;

  while (index < lines.length) {
    const line = lines[index]!;
    if (line.startsWith('@@') || line.startsWith(MOVE_TO_PREFIX) || isOperationBoundary(line)) break;
    if (line.startsWith('\\')) {
      index++;
      continue;
    }

    const prefix = line[0];
    const text = line.slice(1);
    if (prefix === ' ') {
      hunkLines.push({ type: 'context', text });
    } else if (prefix === '-') {
      hunkLines.push({ type: 'remove', text });
      hasEdit = true;
    } else if (prefix === '+') {
      hunkLines.push({ type: 'add', text });
      hasEdit = true;
    } else {
      throw new Error(`hunk 内容行必须以空格、- 或 + 开头（第 ${index + 1} 行）`);
    }
    index++;
  }

  if (hunkLines.length === 0) throw new Error(`第 ${startIndex + 1} 行的 hunk 为空`);
  if (!hasEdit) throw new Error(`第 ${startIndex + 1} 行的 hunk 没有任何增删内容`);
  return { hunk: { header, lines: hunkLines }, nextIndex: index };
}

function isOperationBoundary(line: string): boolean {
  return (
    line === END_MARKER ||
    line.startsWith(ADD_FILE_PREFIX) ||
    line.startsWith(UPDATE_FILE_PREFIX) ||
    line.startsWith(DELETE_FILE_PREFIX)
  );
}

function ensureOnlyTrailingBlankLines(lines: string[], index: number): void {
  for (let i = index; i < lines.length; i++) {
    if (lines[i] !== '') throw new Error(`${END_MARKER} 后不应再出现内容（第 ${i + 1} 行）`);
  }
}

async function preparePatchApplication(
  operations: PatchOperation[],
): Promise<{ pendingFiles: Map<string, LoadedFile>; changes: AppliedChange[] }> {
  const pendingFiles = new Map<string, LoadedFile>();
  const changes: AppliedChange[] = [];

  async function loadFile(filePath: string): Promise<LoadedFile> {
    const resolvedPath = resolve(filePath);
    if (pendingFiles.has(resolvedPath)) return pendingFiles.get(resolvedPath) ?? null;
    return await readTextFileOrNull(resolvedPath);
  }

  function setFile(filePath: string, content: LoadedFile): void {
    pendingFiles.set(resolve(filePath), content);
  }

  for (const operation of operations) {
    if (operation.type === 'add') {
      const existing = await loadFile(operation.path);
      if (existing !== null) throw new Error(`Add File 失败：${operation.path} 已存在`);
      setFile(operation.path, joinLines(operation.lines, operation.lines.length > 0));
      changes.push({ type: 'add', path: operation.path });
      continue;
    }

    if (operation.type === 'delete') {
      const existing = await loadFile(operation.path);
      if (existing === null) throw new Error(`Delete File 失败：${operation.path} 不存在`);
      setFile(operation.path, null);
      changes.push({ type: 'delete', path: operation.path });
      continue;
    }

    const existing = await loadFile(operation.path);
    if (existing === null) throw new Error(`Update File 失败：${operation.path} 不存在`);
    const updated = operation.hunks.length > 0 ? applyHunks(existing, operation.hunks, operation.path) : existing;

    if (operation.moveTo && resolve(operation.moveTo) !== resolve(operation.path)) {
      const destination = await loadFile(operation.moveTo);
      if (destination !== null) throw new Error(`Move to 失败：${operation.moveTo} 已存在`);
      setFile(operation.path, null);
      setFile(operation.moveTo, updated);
      changes.push({ type: 'move', path: operation.path, moveTo: operation.moveTo });
    } else {
      setFile(operation.path, updated);
      changes.push({ type: 'update', path: operation.path });
    }
  }

  return { pendingFiles, changes };
}

async function readTextFileOrNull(filePath: string): Promise<LoadedFile> {
  try {
    const stats = await stat(filePath);
    if (stats.isDirectory()) throw new Error(`${filePath} 是目录，无法应用 patch`);
    return await readFile(filePath, 'utf-8');
  } catch (error) {
    if (isNotFoundError(error)) return null;
    throw error;
  }
}

function applyHunks(content: string, hunks: PatchHunk[], filePath: string): string {
  const split = splitContent(content);
  const lines = [...split.lines];
  let cursor = 0;

  for (const hunk of hunks) {
    const oldLines = hunk.lines.flatMap((line) => (line.type === 'add' ? [] : [line.text]));
    const newLines = hunk.lines.flatMap((line) => (line.type === 'remove' ? [] : [line.text]));

    if (oldLines.length === 0) {
      const insertIndex = findPureInsertionIndex(lines, hunk, cursor, filePath);
      lines.splice(insertIndex, 0, ...newLines);
      cursor = insertIndex + newLines.length;
      continue;
    }

    const matchIndex = findUniqueSequence(lines, oldLines, cursor, filePath);
    lines.splice(matchIndex, oldLines.length, ...newLines);
    cursor = matchIndex + newLines.length;
  }

  return joinLines(lines, split.trailingNewline);
}

function splitContent(content: string): { lines: string[]; trailingNewline: boolean } {
  const normalized = content.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const trailingNewline = normalized.endsWith('\n');
  if (normalized.length === 0) return { lines: [], trailingNewline: false };
  const lines = normalized.split('\n');
  if (trailingNewline) lines.pop();
  return { lines, trailingNewline };
}

function joinLines(lines: string[], trailingNewline: boolean): string {
  if (lines.length === 0) return '';
  return `${lines.join('\n')}${trailingNewline ? '\n' : ''}`;
}

function findUniqueSequence(lines: string[], needle: string[], cursor: number, filePath: string): number {
  const forwardMatches = findSequenceMatches(lines, needle, cursor);
  if (forwardMatches.length === 1) return forwardMatches[0]!;
  if (forwardMatches.length > 1) {
    throw new Error(`Update File 失败：${filePath} 中 hunk 匹配不唯一，请提供更多上下文`);
  }

  const allMatches = findSequenceMatches(lines, needle, 0);
  if (allMatches.length === 1) return allMatches[0]!;
  if (allMatches.length > 1) {
    throw new Error(`Update File 失败：${filePath} 中 hunk 匹配不唯一，请提供更多上下文`);
  }
  throw new Error(`Update File 失败：${filePath} 中找不到 hunk 对应内容`);
}

function findSequenceMatches(lines: string[], needle: string[], startIndex: number): number[] {
  const matches: number[] = [];
  if (needle.length === 0) return matches;

  for (let i = Math.max(0, startIndex); i <= lines.length - needle.length; i++) {
    let matched = true;
    for (let j = 0; j < needle.length; j++) {
      if (lines[i + j] !== needle[j]) {
        matched = false;
        break;
      }
    }
    if (matched) matches.push(i);
  }
  return matches;
}

function findPureInsertionIndex(lines: string[], hunk: PatchHunk, cursor: number, filePath: string): number {
  const headerText = extractHeaderText(hunk.header);
  if (!headerText || headerText === 'EOF' || headerText === 'End of File') return lines.length;

  const forwardMatches = findLineIncludes(lines, headerText, cursor);
  if (forwardMatches.length === 1) return forwardMatches[0]! + 1;
  if (forwardMatches.length > 1) {
    throw new Error(`Update File 失败：${filePath} 中插入锚点匹配不唯一：${headerText}`);
  }

  const allMatches = findLineIncludes(lines, headerText, 0);
  if (allMatches.length === 1) return allMatches[0]! + 1;
  if (allMatches.length > 1) {
    throw new Error(`Update File 失败：${filePath} 中插入锚点匹配不唯一：${headerText}`);
  }
  throw new Error(`Update File 失败：${filePath} 中找不到插入锚点：${headerText}`);
}

function extractHeaderText(header: string): string {
  let text = header.slice(2).trim();
  if (text.endsWith('@@')) text = text.slice(0, -2).trim();
  if (/^-\d/.test(text)) return '';
  return text;
}

function findLineIncludes(lines: string[], text: string, startIndex: number): number[] {
  const matches: number[] = [];
  for (let i = Math.max(0, startIndex); i < lines.length; i++) {
    if (lines[i]!.includes(text)) matches.push(i);
  }
  return matches;
}

function formatSummary(changes: AppliedChange[]): string {
  const counts = changes.reduce(
    (acc, change) => {
      acc[change.type]++;
      return acc;
    },
    { add: 0, update: 0, delete: 0, move: 0 },
  );

  const header = [
    'apply_patch 成功',
    counts.add ? `新增 ${counts.add}` : undefined,
    counts.update ? `更新 ${counts.update}` : undefined,
    counts.delete ? `删除 ${counts.delete}` : undefined,
    counts.move ? `移动 ${counts.move}` : undefined,
  ]
    .filter(Boolean)
    .join('：');

  const details = changes.slice(0, MAX_SUMMARY_CHANGES).map((change) => {
    if (change.type === 'move') return `- move ${change.path} -> ${change.moveTo}`;
    return `- ${change.type} ${change.path}`;
  });
  if (changes.length > MAX_SUMMARY_CHANGES) details.push(`- ... 另有 ${changes.length - MAX_SUMMARY_CHANGES} 项`);

  return [header, ...details].join('\n');
}

function isNotFoundError(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT');
}
