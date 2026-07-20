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
  additions: number;
  deletions: number;
};

export type DiffFileSummary = {
  additions: number;
  deletions: number;
  binary: boolean;
  untracked: boolean;
};

export type GitDiffSummary = {
  additions: number;
  deletions: number;
  files: Map<string, DiffFileSummary>;
};

export function loadDiffSummary(files: TrackedGitFile[], cwd = process.cwd()): GitDiffSummary {
  const root = gitText(['rev-parse', '--show-toplevel'], { cwd }).trim();
  const summaries = new Map<string, DiffFileSummary>();
  for (const file of files) {
    summaries.set(file.path, { additions: 0, deletions: 0, binary: false, untracked: file.status === '??' });
  }

  mergeNumstat(
    summaries,
    runDiff(root, ['diff', '--cached', '--numstat', '-z', ...summarySimilarityArgs(files, 0), '--no-ext-diff', '--']),
  );
  mergeNumstat(
    summaries,
    runDiff(root, ['diff', '--numstat', '-z', ...summarySimilarityArgs(files, 1), '--no-ext-diff', '--']),
  );

  let additions = 0;
  let deletions = 0;
  for (const summary of summaries.values()) {
    additions += summary.additions;
    deletions += summary.deletions;
  }
  return { additions, deletions, files: summaries };
}

export function loadFileDiff(file: TrackedGitFile, cwd = process.cwd()): FileDiffDetail {
  const root = gitText(['rev-parse', '--show-toplevel'], { cwd }).trim();
  if (file.status === '??') return untrackedDiff(file, root);
  if (isUnmergedStatus(file.status)) {
    return {
      file,
      rows: [messageRow('文件存在 Git 合并冲突，请先解决冲突标记后再查看普通 Diff')],
      binary: false,
      additions: 0,
      deletions: 0,
    };
  }

  const rows: SideBySideDiffRow[] = [];
  let binary = false;
  let additions = 0;
  let deletions = 0;
  const [indexStatus, worktreeStatus] = file.status;
  const paths = diffPaths(root, file);
  if (indexStatus && indexStatus !== ' ' && indexStatus !== '?') {
    const parsed = parseUnifiedDiff(
      runDiff(root, [
        'diff',
        '--cached',
        '--no-ext-diff',
        '--no-color',
        '--unified=3',
        ...similarityArgs(indexStatus),
        '--',
        ...paths,
      ]),
    );
    rows.push(sectionRow('STAGED  HEAD', 'INDEX'), ...parsed.rows);
    binary ||= parsed.binary;
    additions += parsed.additions;
    deletions += parsed.deletions;
  }
  if (worktreeStatus && worktreeStatus !== ' ' && worktreeStatus !== '?') {
    const parsed = parseUnifiedDiff(
      runDiff(root, [
        'diff',
        '--no-ext-diff',
        '--no-color',
        '--unified=3',
        ...similarityArgs(worktreeStatus),
        '--',
        ...paths,
      ]),
    );
    rows.push(sectionRow('WORKTREE  INDEX', 'WORKTREE'), ...parsed.rows);
    binary ||= parsed.binary;
    additions += parsed.additions;
    deletions += parsed.deletions;
  }

  if (rows.length === 0) rows.push(messageRow('没有可显示的文本差异'));
  return { file, rows, binary, additions, deletions };
}

export function parseUnifiedDiff(diff: string): {
  rows: SideBySideDiffRow[];
  binary: boolean;
  additions: number;
  deletions: number;
} {
  const rows: SideBySideDiffRow[] = [];
  let oldLine = 0;
  let newLine = 0;
  let inHunk = false;
  let binary = false;
  let additions = 0;
  let deletions = 0;
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
      deletions++;
      continue;
    }
    if (line.startsWith('+')) {
      adds.push({ line: newLine++, text: line.slice(1) });
      additions++;
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
  return { rows, binary, additions, deletions };
}

function untrackedDiff(file: TrackedGitFile, root: string): FileDiffDetail {
  const fullPath = join(root, file.path);
  try {
    const stat = lstatSync(fullPath);
    const content = stat.isSymbolicLink() ? Buffer.from(readlinkSync(fullPath)) : readFileSync(fullPath);
    if (content.includes(0)) {
      return { file, rows: [messageRow('未跟踪的二进制文件')], binary: true, additions: 0, deletions: 0 };
    }
    const lines = content.toString('utf8').split('\n');
    if (lines.at(-1) === '') lines.pop();
    return {
      file,
      binary: false,
      additions: lines.length,
      deletions: 0,
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
    return { file, rows: [messageRow('文件已不存在')], binary: false, additions: 0, deletions: 0 };
  }
}

function mergeNumstat(summaries: Map<string, DiffFileSummary>, output: string): void {
  const records = output.split('\0');
  for (let index = 0; index < records.length; index++) {
    const record = records[index];
    if (!record) continue;
    const firstTab = record.indexOf('\t');
    const secondTab = record.indexOf('\t', firstTab + 1);
    if (firstTab < 0 || secondTab < 0) continue;
    const added = record.slice(0, firstTab);
    const removed = record.slice(firstTab + 1, secondTab);
    let path = record.slice(secondTab + 1);
    if (!path) {
      index++;
      path = records[++index] ?? '';
    }
    const current = summaries.get(path);
    if (!current) continue;
    if (added === '-' || removed === '-') {
      current.binary = true;
      continue;
    }
    current.additions += Number(added) || 0;
    current.deletions += Number(removed) || 0;
  }
}

function diffPaths(root: string, file: TrackedGitFile): string[] {
  if (!file.status.includes('R') && !file.status.includes('C')) return [file.path];
  const records = runDiff(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all']).split('\0');
  for (let index = 0; index < records.length; index++) {
    const entry = records[index];
    if (!entry) continue;
    const status = entry.slice(0, 2);
    const path = entry.slice(3);
    if (!status.includes('R') && !status.includes('C')) continue;
    const source = records[++index];
    if (path === file.path && source) return [source, file.path];
  }
  return [file.path];
}

function similarityArgs(status: string): string[] {
  if (status === 'R') return ['--find-renames', '--diff-filter=R'];
  if (status === 'C') return ['--find-copies-harder', '--diff-filter=C'];
  return [];
}

function summarySimilarityArgs(files: TrackedGitFile[], statusIndex: 0 | 1): string[] {
  return files.some((file) => file.status[statusIndex] === 'C')
    ? ['--find-renames', '--find-copies-harder']
    : ['--find-renames'];
}

function isUnmergedStatus(status: string): boolean {
  return (
    status === 'DD' ||
    status === 'AU' ||
    status === 'UD' ||
    status === 'UA' ||
    status === 'DU' ||
    status === 'AA' ||
    status === 'UU'
  );
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
