import { execFileSync } from 'node:child_process';
import { lstatSync, readFileSync, readlinkSync } from 'node:fs';
import { join } from 'node:path';
import { gitText } from '@packages/mica-common/index.js';
import type { TrackedGitFile } from './agentChangeTracker.js';

export type DiffCellKind = 'context' | 'delete' | 'add' | 'empty' | 'meta';

export type SideBySideDiffRow = {
  kind: 'content' | 'hunk' | 'section' | 'message';
  leftLine?: number;
  rightLine?: number;
  leftText: string;
  rightText: string;
  leftKind: DiffCellKind;
  rightKind: DiffCellKind;
};

export type FileDiffDetail = {
  file: TrackedGitFile;
  rows: SideBySideDiffRow[];
  binary: boolean;
};

export function loadFileDiff(file: TrackedGitFile, cwd = process.cwd()): FileDiffDetail {
  const root = gitText(['rev-parse', '--show-toplevel'], { cwd }).trim();
  if (file.status === '??') return untrackedDiff(file, root);

  const rows: SideBySideDiffRow[] = [];
  let binary = false;
  const [indexStatus, worktreeStatus] = file.status;
  if (indexStatus && indexStatus !== ' ' && indexStatus !== '?') {
    const parsed = parseUnifiedDiff(
      runDiff(root, ['diff', '--cached', '--no-ext-diff', '--no-color', '--unified=3', '--', file.path]),
    );
    rows.push(sectionRow('STAGED  HEAD', 'INDEX'), ...parsed.rows);
    binary ||= parsed.binary;
  }
  if (worktreeStatus && worktreeStatus !== ' ' && worktreeStatus !== '?') {
    const parsed = parseUnifiedDiff(
      runDiff(root, ['diff', '--no-ext-diff', '--no-color', '--unified=3', '--', file.path]),
    );
    rows.push(sectionRow('WORKTREE  INDEX', 'WORKTREE'), ...parsed.rows);
    binary ||= parsed.binary;
  }

  if (rows.length === 0) rows.push(messageRow('没有可显示的文本差异'));
  return { file, rows, binary };
}

export function parseUnifiedDiff(diff: string): { rows: SideBySideDiffRow[]; binary: boolean } {
  const rows: SideBySideDiffRow[] = [];
  let oldLine = 0;
  let newLine = 0;
  let inHunk = false;
  let binary = false;
  let deletes: Array<{ line: number; text: string }> = [];
  let adds: Array<{ line: number; text: string }> = [];

  const flushChanges = () => {
    const count = Math.max(deletes.length, adds.length);
    for (let index = 0; index < count; index++) {
      const left = deletes[index];
      const right = adds[index];
      rows.push({
        kind: 'content',
        leftLine: left?.line,
        rightLine: right?.line,
        leftText: left?.text ?? '',
        rightText: right?.text ?? '',
        leftKind: left ? 'delete' : 'empty',
        rightKind: right ? 'add' : 'empty',
      });
    }
    deletes = [];
    adds = [];
  };

  for (const line of diff.split('\n')) {
    if (line.startsWith('Binary files ') || line === 'GIT binary patch') binary = true;
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/.exec(line);
    if (hunk) {
      flushChanges();
      inHunk = true;
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
      rows.push({
        kind: 'hunk',
        leftText: `@@ -${hunk[1]} ${hunk[3] ?? ''}`.trimEnd(),
        rightText: `@@ +${hunk[2]} ${hunk[3] ?? ''}`.trimEnd(),
        leftKind: 'meta',
        rightKind: 'meta',
      });
      continue;
    }
    if (!inHunk) continue;
    if (line.startsWith('\\ No newline at end of file')) continue;
    if (line.startsWith('-')) {
      deletes.push({ line: oldLine++, text: line.slice(1) });
      continue;
    }
    if (line.startsWith('+')) {
      adds.push({ line: newLine++, text: line.slice(1) });
      continue;
    }
    flushChanges();
    if (line.startsWith(' ')) {
      rows.push({
        kind: 'content',
        leftLine: oldLine++,
        rightLine: newLine++,
        leftText: line.slice(1),
        rightText: line.slice(1),
        leftKind: 'context',
        rightKind: 'context',
      });
    }
  }
  flushChanges();
  if (binary) rows.push(messageRow('二进制文件，无法展示文本 Diff'));
  if (rows.length === 0) rows.push(messageRow('仅文件元数据发生变化，或没有文本差异'));
  return { rows, binary };
}

function untrackedDiff(file: TrackedGitFile, root: string): FileDiffDetail {
  const fullPath = join(root, file.path);
  try {
    const stat = lstatSync(fullPath);
    const content = stat.isSymbolicLink() ? Buffer.from(readlinkSync(fullPath)) : readFileSync(fullPath);
    if (content.includes(0)) return { file, rows: [messageRow('未跟踪的二进制文件')], binary: true };
    const lines = content.toString('utf8').split('\n');
    if (lines.at(-1) === '') lines.pop();
    return {
      file,
      binary: false,
      rows: [
        sectionRow('UNTRACKED  EMPTY', 'WORKTREE'),
        ...lines.map(
          (text, index): SideBySideDiffRow => ({
            kind: 'content',
            rightLine: index + 1,
            leftText: '',
            rightText: text,
            leftKind: 'empty',
            rightKind: 'add',
          }),
        ),
      ],
    };
  } catch {
    return { file, rows: [messageRow('文件已不存在')], binary: false };
  }
}

function runDiff(root: string, args: string[]): string {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
}

function sectionRow(left: string, right: string): SideBySideDiffRow {
  return { kind: 'section', leftText: left, rightText: right, leftKind: 'meta', rightKind: 'meta' };
}

function messageRow(message: string): SideBySideDiffRow {
  return { kind: 'message', leftText: message, rightText: message, leftKind: 'meta', rightKind: 'meta' };
}
