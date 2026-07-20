import React from 'react';
import { Box, Text, stringWidth, useTerminalSize } from '@anthropic/ink';
import { atom } from 'nanostores';
import { micaUi } from '@packages/mica-ui/index.js';
import type { SelectItem } from '@packages/mica-ui/index.js';
import type { AgentChangeTracker, ChangeOwner, TrackedGitFile } from '../git/agentChangeTracker.js';
import { moveSelection, selectionDirection } from '../shared/commandInput.js';
import {
  loadDiffSummary,
  loadFileDiff,
  type DiffCellKind,
  type DiffFileSummary,
  type FileDiffDetail,
  type SideBySideDiffRow,
} from '../git/gitDiff.js';
import type { CommandAgent, CommandRuntimeServices } from '../services.js';

const PANEL_ID = 'git-diff-panel';
const SCROLL_STEP_X = 8;
const SPLIT_VIEW_MIN_COLUMNS = 100;

export function createDiffCommand(agent: CommandAgent, services: CommandRuntimeServices, tracker: AgentChangeTracker) {
  return {
    name: 'diff',
    description: '交互查看当前 Git 变更及其来源',
    action: () => {
      const target = services.getCurrentAgent() ?? agent;
      try {
        showDiffPanel(tracker.list(target.taskOwnerId), services);
      } catch (error) {
        services.showMessage(`diff failed: ${error instanceof Error ? error.message : String(error)}`, 5000);
      }
    },
  } satisfies Parameters<typeof micaUi.dropdown.setQuickCommands>[0][number];
}

function showDiffPanel(files: TrackedGitFile[], services: CommandRuntimeServices) {
  const summary = loadDiffSummary(files);
  const view = atom<'list' | 'detail'>('list');
  const query = atom('');
  const selectedIdx = atom(0);
  const scrollY = atom(0);
  const scrollX = atom(0);
  let detail: FileDiffDetail | undefined;
  let maxScrollY = 0;
  let maxScrollX = 0;

  const visibleFiles = () => {
    const needle = query.get().trim().toLowerCase();
    return needle
      ? files.filter((file) =>
          `${file.path} ${file.status} ${ownerLabel(file.owner)} ${changeScopeLabel(file.status)}`
            .toLowerCase()
            .includes(needle),
        )
      : files;
  };

  const hide = () => {
    micaUi.terminalInput.clearText();
    micaUi.panels.removePluginUI(PANEL_ID);
  };

  const openCurrent = () => {
    const file = visibleFiles()[selectedIdx.get()];
    if (!file) return;
    try {
      detail = loadFileDiff(file);
      scrollY.set(0);
      scrollX.set(0);
      query.set('');
      selectedIdx.set(Math.max(0, files.indexOf(file)));
      micaUi.terminalInput.clearText();
      view.set('detail');
    } catch (error) {
      services.showMessage(`diff failed: ${error instanceof Error ? error.message : String(error)}`, 5000);
    }
  };

  function DiffPanel() {
    const currentView = micaUi.useScheduleState(view);
    const currentIdx = micaUi.useScheduleState(selectedIdx);
    const currentQuery = micaUi.useScheduleState(query);
    if (currentView === 'detail' && detail) {
      return (
        <DiffDetail
          detail={detail}
          scrollY={scrollY}
          scrollX={scrollX}
          onViewportBounds={(nextMaxY, nextMaxX) => {
            maxScrollY = nextMaxY;
            maxScrollX = nextMaxX;
          }}
        />
      );
    }
    const visible = visibleFiles();
    const items: DiffSelectItem[] = visible.map((file) => ({
      key: file.path,
      label: file.path,
      labelMaxWidth: '55%',
      status: (
        <Text color={gitStatusColor(file.status)} bold>
          {file.status}
        </Text>
      ),
      description: (
        <Text>
          <Text color={ownerColor(file.owner)}>{ownerShortLabel(file.owner)}</Text>
          <Text dimColor> · {changeScopeLabel(file.status)}</Text>
        </Text>
      ),
      suffix: <DiffStats summary={summary.files.get(file.path)} />,
      file,
    }));
    const ownerCounts = countOwners(files);
    return (
      <micaUi.Dialog
        title={
          <Text>
            Git 变更{' '}
            <Text dimColor>{currentQuery ? `${items.length} / ${files.length} 个文件` : `${files.length} 个文件`}</Text>
            {summary.additions > 0 && <Text color={micaUi.theme.colors.success}> +{summary.additions}</Text>}
            {summary.deletions > 0 && <Text color={micaUi.theme.colors.error}> -{summary.deletions}</Text>}
          </Text>
        }
        footer={<micaUi.KeyHints hints={['输入搜索', '↑↓ 选择', '↵ 查看', 'esc 关闭']} />}
      >
        {files.length > 0 && (
          <Text dimColor>
            当前 Agent {ownerCounts.agent} · 混合 {ownerCounts.mixed} · 其他 {ownerCounts.other}
          </Text>
        )}
        <micaUi.SelectList
          items={items}
          selectedIdx={currentIdx}
          empty={<Text dimColor>{currentQuery ? '没有匹配的文件' : '工作区没有未提交变更'}</Text>}
          itemGap={0}
          layout="table"
          highlightText={currentQuery}
        />
      </micaUi.Dialog>
    );
  }

  micaUi.terminalInput.clearText();
  micaUi.panels.setExclusivePluginUI({
    id: PANEL_ID,
    component: DiffPanel,
    preserveInput: true,
    onTextChange: (text) => {
      if (view.get() === 'detail') {
        micaUi.terminalInput.clearText();
        return true;
      }
      query.set(text);
      selectedIdx.set(0);
      return true;
    },
    onInput: (input, key) => {
      if (view.get() === 'detail') {
        if (key.escape) {
          view.set('list');
          return true;
        }
        if (key.upArrow || input === 'k') scrollY.set(Math.max(0, Math.min(scrollY.get(), maxScrollY) - 1));
        else if (key.downArrow || input === 'j') scrollY.set(Math.min(maxScrollY, scrollY.get() + 1));
        else if (key.leftArrow || input === 'h')
          scrollX.set(Math.max(0, Math.min(scrollX.get(), maxScrollX) - SCROLL_STEP_X));
        else if (key.rightArrow || input === 'l') scrollX.set(Math.min(maxScrollX, scrollX.get() + SCROLL_STEP_X));
        else return true;
        return true;
      }
      if (key.escape) {
        hide();
        return true;
      }
      if (key.return) {
        openCurrent();
        return true;
      }
      const direction = selectionDirection(key);
      if (direction) {
        const count = visibleFiles().length;
        if (count > 0) selectedIdx.set(moveSelection(selectedIdx.get(), count, direction));
        return true;
      }
      return false;
    },
  });
}

function DiffDetail({
  detail,
  scrollY,
  scrollX,
  onViewportBounds,
}: {
  detail: FileDiffDetail;
  scrollY: ReturnType<typeof atom<number>>;
  scrollX: ReturnType<typeof atom<number>>;
  onViewportBounds: (maxY: number, maxX: number) => void;
}) {
  const { columns, rows } = useTerminalSize();
  const offsetY = micaUi.useScheduleState(scrollY);
  const offsetX = micaUi.useScheduleState(scrollX);
  const mode: DiffDisplayMode = columns >= SPLIT_VIEW_MIN_COLUMNS ? 'split' : 'unified';
  const displayRows = buildDisplayRows(detail.rows, mode);
  const visibleCount = Math.max(4, rows - 9);
  const columnWidth = Math.max(12, Math.floor((columns - 3) / 2));
  const contentWidth = Math.max(4, mode === 'split' ? columnWidth - 7 : columns - 9);
  const maxContentWidth = Math.max(0, ...displayRows.map(displayRowWidth));
  const maxY = Math.max(0, displayRows.length - visibleCount);
  const maxX = Math.max(0, maxContentWidth - contentWidth);
  const safeOffsetY = Math.min(offsetY, maxY);
  const safeOffsetX = Math.min(offsetX, maxX);
  const visibleRows = displayRows.slice(safeOffsetY, safeOffsetY + visibleCount);
  onViewportBounds(maxY, maxX);

  return (
    <micaUi.Dialog
      title={
        <Text wrap="truncate-end">
          <Text color={micaUi.theme.colors.accent}>{detail.file.path}</Text>{' '}
          <Text dimColor>{detail.file.status} · </Text>
          <Text color={ownerColor(detail.file.owner)}>{ownerLabel(detail.file.owner)}</Text>
          {detail.additions > 0 && <Text color={micaUi.theme.colors.success}> +{detail.additions}</Text>}
          {detail.deletions > 0 && <Text color={micaUi.theme.colors.error}> -{detail.deletions}</Text>}
          {detail.binary && <Text dimColor> · 二进制</Text>}
        </Text>
      }
      footer={<micaUi.KeyHints hints={['↑↓/jk 滚动', '←→/hl 横移', 'esc 返回']} />}
      paddingX={0}
    >
      <Box flexDirection="column" width="100%">
        {visibleRows.map((row, index) => (
          <DisplayDiffRow
            key={`${safeOffsetY + index}-${row.kind}`}
            row={row}
            offsetX={safeOffsetX}
            contentWidth={contentWidth}
          />
        ))}
      </Box>
      <Text dimColor>
        行 {displayRows.length === 0 ? 0 : safeOffsetY + 1}–{Math.min(safeOffsetY + visibleCount, displayRows.length)} /{' '}
        {displayRows.length}
        {maxContentWidth > contentWidth &&
          ` · 列 ${safeOffsetX + 1}–${Math.min(safeOffsetX + contentWidth, maxContentWidth)} / ${maxContentWidth}`}
        <Text> · {mode === 'split' ? '双栏' : '单栏'}</Text>
      </Text>
    </micaUi.Dialog>
  );
}

type DiffDisplayMode = 'split' | 'unified';

type DisplayRow =
  | { kind: 'structure'; row: SideBySideDiffRow }
  | { kind: 'split'; row: SideBySideDiffRow }
  | { kind: 'unified'; line?: number; text: string; cellKind: DiffCellKind };

function buildDisplayRows(rows: SideBySideDiffRow[], mode: DiffDisplayMode): DisplayRow[] {
  const result: DisplayRow[] = [];
  for (const row of rows) {
    if (row.kind !== 'content') {
      result.push({ kind: 'structure', row });
      continue;
    }
    if (mode === 'split') {
      result.push({ kind: 'split', row });
      continue;
    }
    if (row.leftKind === 'context' && row.rightKind === 'context') {
      result.push({ kind: 'unified', line: row.rightLine, text: row.rightText, cellKind: 'context' });
      continue;
    }
    if (row.leftKind !== 'empty') {
      result.push({ kind: 'unified', line: row.leftLine, text: row.leftText, cellKind: row.leftKind });
    }
    if (row.rightKind !== 'empty') {
      result.push({ kind: 'unified', line: row.rightLine, text: row.rightText, cellKind: row.rightKind });
    }
  }
  return result;
}

function DisplayDiffRow({ row, offsetX, contentWidth }: { row: DisplayRow; offsetX: number; contentWidth: number }) {
  if (row.kind === 'structure') return <DiffStructureRow row={row.row} />;
  if (row.kind === 'unified') {
    return (
      <DiffCell line={row.line} text={row.text} kind={row.cellKind} offsetX={offsetX} width={contentWidth} fullWidth />
    );
  }
  return (
    <Box width="100%" flexDirection="row">
      <DiffCell
        line={row.row.leftLine}
        text={row.row.leftText}
        kind={row.row.leftKind}
        offsetX={offsetX}
        width={contentWidth}
      />
      <Text dimColor> │ </Text>
      <DiffCell
        line={row.row.rightLine}
        text={row.row.rightText}
        kind={row.row.rightKind}
        offsetX={offsetX}
        width={contentWidth}
      />
    </Box>
  );
}

function DiffStructureRow({ row }: { row: SideBySideDiffRow }) {
  if (row.kind === 'section') {
    const section = sectionDescription(row);
    return (
      <Box width="100%" paddingX={1} backgroundColor={micaUi.theme.colors.surfaceSelected} overflowX="hidden">
        <Text color={micaUi.theme.colors.info} bold>
          {section.label}
        </Text>
        <Text dimColor wrap="truncate-end">
          {' '}
          · {section.transition}
        </Text>
      </Box>
    );
  }
  if (row.kind === 'hunk') {
    return (
      <Box width="100%" paddingLeft={1}>
        <Text color={micaUi.theme.colors.info} dimColor wrap="truncate-end">
          {row.leftText} → {row.rightText}
        </Text>
      </Box>
    );
  }
  return (
    <Box width="100%" paddingLeft={2}>
      <Text dimColor italic wrap="truncate-end">
        {row.leftText}
      </Text>
    </Box>
  );
}

function DiffCell({
  line,
  text,
  kind,
  offsetX,
  width,
  fullWidth = false,
}: {
  line?: number;
  text: string;
  kind: DiffCellKind;
  offsetX: number;
  width: number;
  fullWidth?: boolean;
}) {
  const marker = kind === 'delete' ? '-' : kind === 'add' ? '+' : ' ';
  const lineNumber = line === undefined ? '    ' : String(line).padStart(4);
  const visible = sliceByDisplayWidth(text.replaceAll('\t', '    '), offsetX, width);
  const color =
    kind === 'delete'
      ? micaUi.theme.colors.error
      : kind === 'add'
        ? micaUi.theme.colors.success
        : kind === 'meta'
          ? micaUi.theme.colors.info
          : undefined;
  return (
    <Box
      width={fullWidth ? '100%' : '50%'}
      minWidth={0}
      backgroundColor={
        kind === 'delete'
          ? micaUi.theme.colors.surfaceError
          : kind === 'add'
            ? micaUi.theme.colors.surfaceCommit
            : undefined
      }
    >
      <Text color={color} dimColor={kind === 'empty'} wrap="truncate">
        {lineNumber} {marker}
        {visible}
      </Text>
    </Box>
  );
}

type DiffSelectItem = SelectItem & { file: TrackedGitFile };

function DiffStats({ summary }: { summary: DiffFileSummary | undefined }): React.ReactNode {
  if (!summary) return null;
  if (summary.untracked) return <Text dimColor>未跟踪</Text>;
  if (summary.binary) return <Text dimColor>二进制</Text>;
  if (summary.additions === 0 && summary.deletions === 0) return <Text dimColor>仅元数据</Text>;
  return (
    <Text>
      {summary.additions > 0 && <Text color={micaUi.theme.colors.success}>+{summary.additions}</Text>}
      {summary.additions > 0 && summary.deletions > 0 && ' '}
      {summary.deletions > 0 && <Text color={micaUi.theme.colors.error}>-{summary.deletions}</Text>}
    </Text>
  );
}

function displayRowWidth(row: DisplayRow): number {
  if (row.kind === 'structure') return 0;
  if (row.kind === 'unified') return stringWidth(row.text.replaceAll('\t', '    '));
  return Math.max(
    stringWidth(row.row.leftText.replaceAll('\t', '    ')),
    stringWidth(row.row.rightText.replaceAll('\t', '    ')),
  );
}

function sectionDescription(row: SideBySideDiffRow): { label: string; transition: string } {
  if (row.leftText.startsWith('STAGED')) return { label: '已暂存', transition: 'HEAD → INDEX' };
  if (row.leftText.startsWith('WORKTREE')) return { label: '未暂存', transition: 'INDEX → WORKTREE' };
  if (row.leftText.startsWith('UNTRACKED')) return { label: '未跟踪', transition: 'EMPTY → WORKTREE' };
  return { label: '变更', transition: `${row.leftText} → ${row.rightText}` };
}

const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

function sliceByDisplayWidth(text: string, start: number, width: number): string {
  let position = 0;
  let used = 0;
  let result = '';
  for (const { segment } of graphemeSegmenter.segment(text)) {
    const segmentWidth = stringWidth(segment);
    if (position + segmentWidth <= start) {
      position += segmentWidth;
      continue;
    }
    if (position < start) {
      position += segmentWidth;
      continue;
    }
    if (used + segmentWidth > width) break;
    result += segment;
    used += segmentWidth;
    position += segmentWidth;
  }
  return result + ' '.repeat(Math.max(0, width - used));
}

function changeScopeLabel(status: string): string {
  if (status === '??') return '未跟踪';
  if (isUnmergedStatus(status)) return '合并冲突';
  const staged = status[0] !== undefined && status[0] !== ' ';
  const worktree = status[1] !== undefined && status[1] !== ' ';
  if (staged && worktree) return '已暂存 + 未暂存';
  if (staged) return '已暂存';
  if (worktree) return '未暂存';
  return '状态变更';
}

function countOwners(files: TrackedGitFile[]): Record<ChangeOwner, number> {
  const result: Record<ChangeOwner, number> = { agent: 0, mixed: 0, other: 0 };
  for (const file of files) result[file.owner]++;
  return result;
}

function ownerLabel(owner: ChangeOwner): string {
  if (owner === 'agent') return '当前 Agent';
  if (owner === 'mixed') return '混合';
  return '非当前 Agent';
}

function ownerShortLabel(owner: ChangeOwner): string {
  if (owner === 'agent') return 'Agent';
  if (owner === 'mixed') return '混合';
  return '其他';
}

function ownerColor(owner: ChangeOwner): string | undefined {
  if (owner === 'agent') return micaUi.theme.colors.success;
  if (owner === 'mixed') return micaUi.theme.colors.warning;
  return undefined;
}

function gitStatusColor(status: string): string | undefined {
  return status.includes('D') || isUnmergedStatus(status)
    ? micaUi.theme.colors.error
    : status === '??'
      ? micaUi.theme.colors.info
      : micaUi.theme.colors.warning;
}

function isUnmergedStatus(status: string): boolean {
  return ['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU'].includes(status);
}
