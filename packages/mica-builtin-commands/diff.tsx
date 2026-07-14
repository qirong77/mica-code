import React from 'react';
import { Box, Text, useTerminalSize } from '@anthropic/ink';
import { atom } from 'nanostores';
import { micaUi } from '@packages/mica-ui/index.js';
import type { SelectItem } from '@packages/mica-ui/index.js';
import type { AgentChangeTracker, ChangeOwner, TrackedGitFile } from './agentChangeTracker.js';
import { moveSelection, selectionDirection } from './commandInput.js';
import { loadFileDiff, type DiffCellKind, type FileDiffDetail, type SideBySideDiffRow } from './gitDiff.js';
import type { CommandAgent, CommandRuntimeServices } from './services.js';

const PANEL_ID = 'git-diff-panel';
const SCROLL_STEP_X = 8;

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
  const view = atom<'list' | 'detail'>('list');
  const query = atom('');
  const selectedIdx = atom(0);
  const scrollY = atom(0);
  const scrollX = atom(0);
  let detail: FileDiffDetail | undefined;

  const visibleFiles = () => {
    const needle = query.get().trim().toLowerCase();
    return needle
      ? files.filter((file) => `${file.path} ${file.status} ${ownerLabel(file.owner)}`.toLowerCase().includes(needle))
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
    if (currentView === 'detail' && detail) return <DiffDetail detail={detail} scrollY={scrollY} scrollX={scrollX} />;
    const visible = visibleFiles();
    const items: DiffSelectItem[] = visible.map((file) => ({
      key: file.path,
      label: file.path,
      description: ownerLabel(file.owner),
      file,
    }));
    return (
      <micaUi.Dialog
        title={<Text dimColor>git changes ({items.length})</Text>}
        footer={<micaUi.KeyHints hints={['type to search', '↑↓ navigate', '↵ view diff', 'esc cancel']} />}
      >
        <micaUi.SelectList
          items={items}
          selectedIdx={currentIdx}
          empty={<Text dimColor>{currentQuery ? 'no matching files' : 'working tree clean'}</Text>}
          itemGap={0}
          layout="table"
          highlightText={currentQuery}
          renderItem={renderDiffFileItem}
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
        if (key.upArrow || input === 'k') scrollY.set(Math.max(0, scrollY.get() - 1));
        else if (key.downArrow || input === 'j')
          scrollY.set(Math.min(Math.max(0, (detail?.rows.length ?? 1) - 1), scrollY.get() + 1));
        else if (key.leftArrow || input === 'h') scrollX.set(Math.max(0, scrollX.get() - SCROLL_STEP_X));
        else if (key.rightArrow || input === 'l') scrollX.set(scrollX.get() + SCROLL_STEP_X);
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
}: {
  detail: FileDiffDetail;
  scrollY: ReturnType<typeof atom<number>>;
  scrollX: ReturnType<typeof atom<number>>;
}) {
  const { columns, rows } = useTerminalSize();
  const offsetY = micaUi.useScheduleState(scrollY);
  const offsetX = micaUi.useScheduleState(scrollX);
  const visibleCount = Math.max(4, rows - 9);
  const visibleRows = detail.rows.slice(offsetY, offsetY + visibleCount);
  const columnWidth = Math.max(12, Math.floor((columns - 5) / 2));
  const contentWidth = Math.max(4, columnWidth - 7);
  return (
    <micaUi.Dialog
      title={
        <Text>
          <Text color={micaUi.theme.colors.accent}>{detail.file.path}</Text>{' '}
          <Text dimColor>
            {detail.file.status} · {ownerLabel(detail.file.owner)}
          </Text>
        </Text>
      }
      footer={<micaUi.KeyHints hints={['↑↓/jk scroll', '←→/hl horizontal', 'esc back']} />}
      paddingX={0}
    >
      <Box width="100%" flexDirection="row">
        <Box width="50%" minWidth={0}>
          <Text bold dimColor>
            OLD
          </Text>
        </Box>
        <Text dimColor> │ </Text>
        <Box width="50%" minWidth={0}>
          <Text bold dimColor>
            NEW
          </Text>
        </Box>
      </Box>
      <Box flexDirection="column" width="100%">
        {visibleRows.map((row, index) => (
          <DiffRow key={`${offsetY + index}-${row.kind}`} row={row} offsetX={offsetX} contentWidth={contentWidth} />
        ))}
      </Box>
      <Text dimColor>
        {Math.min(offsetY + 1, detail.rows.length)}/{detail.rows.length} · column {offsetX + 1}
      </Text>
    </micaUi.Dialog>
  );
}

function DiffRow({ row, offsetX, contentWidth }: { row: SideBySideDiffRow; offsetX: number; contentWidth: number }) {
  return (
    <Box width="100%" flexDirection="row">
      <DiffCell line={row.leftLine} text={row.leftText} kind={row.leftKind} offsetX={offsetX} width={contentWidth} />
      <Text dimColor> │ </Text>
      <DiffCell line={row.rightLine} text={row.rightText} kind={row.rightKind} offsetX={offsetX} width={contentWidth} />
    </Box>
  );
}

function DiffCell({
  line,
  text,
  kind,
  offsetX,
  width,
}: {
  line?: number;
  text: string;
  kind: DiffCellKind;
  offsetX: number;
  width: number;
}) {
  const marker = kind === 'delete' ? '-' : kind === 'add' ? '+' : ' ';
  const lineNumber = line === undefined ? '    ' : String(line).padStart(4);
  const visible = text
    .replaceAll('\t', '    ')
    .slice(offsetX, offsetX + width)
    .padEnd(width);
  const color =
    kind === 'delete'
      ? micaUi.theme.colors.error
      : kind === 'add'
        ? micaUi.theme.colors.success
        : kind === 'meta'
          ? micaUi.theme.colors.info
          : undefined;
  return (
    <Box width="50%" minWidth={0}>
      <Text color={color} dimColor={kind === 'empty'} wrap="truncate">
        {lineNumber} {marker}
        {visible}
      </Text>
    </Box>
  );
}

type DiffSelectItem = SelectItem & { file: TrackedGitFile };

function renderDiffFileItem(item: DiffSelectItem, isSelected: boolean, index: number): React.ReactNode {
  return (
    <Box width="100%" backgroundColor={isSelected ? '#3A3A3A' : index % 2 ? '#303030' : '#292929'}>
      <micaUi.OneLineItem
        cells={[
          {
            key: 'status',
            content: item.file.status,
            width: 4,
            flexShrink: 0,
            color: gitStatusColor(item.file.status),
          },
          {
            key: 'owner',
            content: item.description,
            width: 14,
            flexShrink: 0,
            color: ownerColor(item.file.owner),
            bold: isSelected,
          },
          {
            key: 'path',
            content: item.label,
            flexGrow: 1,
            flexShrink: 1,
            minWidth: 20,
            color: isSelected ? micaUi.theme.colors.accent : undefined,
            bold: isSelected,
          },
        ]}
      />
    </Box>
  );
}

function ownerLabel(owner: ChangeOwner): string {
  if (owner === 'agent') return '当前 Agent';
  if (owner === 'mixed') return '混合';
  return '非当前 Agent';
}

function ownerColor(owner: ChangeOwner): string | undefined {
  if (owner === 'agent') return micaUi.theme.colors.success;
  if (owner === 'mixed') return micaUi.theme.colors.warning;
  return undefined;
}

function gitStatusColor(status: string): string | undefined {
  return status.includes('D')
    ? micaUi.theme.colors.error
    : status === '??'
      ? micaUi.theme.colors.info
      : micaUi.theme.colors.warning;
}
