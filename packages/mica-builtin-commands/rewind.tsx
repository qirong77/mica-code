import { Box, Text } from '@anthropic/ink';
import { atom } from 'nanostores';
import { micaUi } from '@packages/mica-ui/index.js';
import type { SelectItem } from '@packages/mica-ui/index.js';
import { formatSessionListTime } from '@packages/mica-ui/utils/format.js';
import type {
  CommandRuntimeServices,
  RewindCheckpointSummary,
  RewindFileChange,
  RewindMode,
  RewindPreviewResult,
} from './services.js';
import { moveSelection, selectionDirection } from './commandInput.js';

const PANEL_ID = 'rewind-panel';
const MAX_VISIBLE_FILES = 14;

type RewindPhase = 'checkpoint' | 'scope';
type SuccessfulPreview = Extract<RewindPreviewResult, { ok: true }>;

export function createRewindCommand(services: CommandRuntimeServices) {
  return {
    name: 'rewind',
    description: '选择一轮对话回退，并将原输入恢复到输入框',
    action: (rawArgs?: string) => {
      if ((rawArgs ?? '').trim()) {
        services.showMessage('rewind: /rewind 不支持参数，请直接运行 /rewind', 5000);
        return;
      }
      if (showBusyMessage(services)) return;

      const checkpoints = services.listRewindCheckpoints();
      if (checkpoints.length === 0) {
        services.showMessage('rewind: 没有可回退的对话', 4000);
        return;
      }
      showRewindPanel(checkpoints, services);
    },
  } satisfies Parameters<typeof micaUi.dropdown.setQuickCommands>[0][number];
}

function showRewindPanel(checkpoints: RewindCheckpointSummary[], services: CommandRuntimeServices): void {
  const phase = atom<RewindPhase>('checkpoint');
  const checkpointIndex = atom(0);
  const modeIndex = atom(0);
  const preview = atom<SuccessfulPreview | null>(null);
  const feedback = atom<string | null>(null);
  const applying = atom(false);
  const ownerSessionId = services.getCurrentAgentSessionId();

  function hide(): void {
    micaUi.panels.removePluginUI(PANEL_ID);
  }

  function modesFor(current: SuccessfulPreview): RewindMode[] {
    return current.fileStateAvailable ? ['conversation_only', 'conversation_and_files'] : ['conversation_only'];
  }

  function chooseSafeDefault(current: SuccessfulPreview): void {
    const hasDelete = current.files.some((file) => file.action === 'delete');
    modeIndex.set(current.fileStateAvailable && !hasDelete ? 1 : 0);
  }

  function openSelectedCheckpoint(): void {
    const selected = checkpoints[checkpointIndex.get()];
    if (!selected) return;
    const result = services.getRewindPreview(selected.id);
    if (!result.ok) {
      feedback.set(result.message);
      return;
    }
    preview.set(result);
    chooseSafeDefault(result);
    feedback.set(null);
    phase.set('scope');
  }

  function refreshStalePreview(id: string): void {
    const refreshed = services.getRewindPreview(id);
    if (!refreshed.ok) {
      feedback.set(refreshed.message);
      phase.set('checkpoint');
      preview.set(null);
      return;
    }
    preview.set(refreshed);
    chooseSafeDefault(refreshed);
    feedback.set('工作区在预览后发生了变化。文件列表已刷新，请重新确认。');
  }

  function confirmSelectedMode(): void {
    if (applying.get()) return;
    if (showBusyMessage(services)) return;
    const current = preview.get();
    if (!current) return;
    const mode = modesFor(current)[modeIndex.get()];
    if (!mode) return;

    applying.set(true);
    feedback.set(null);
    let result: ReturnType<CommandRuntimeServices['applyRewind']>;
    try {
      result = services.applyRewind({
        id: current.id,
        mode,
        previewToken: current.previewToken,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes('rewind stale preview')) {
        refreshStalePreview(current.id);
      } else {
        feedback.set(`rewind failed: ${message}`);
      }
      applying.set(false);
      return;
    }

    hide();
    micaUi.terminalInput.text.set(result.inputText);
    try {
      services.showNotice(formatSuccessNotice(result), ownerSessionId, {
        command: '/rewind',
        status: result.postApplyWarning ? 'warning' : 'success',
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      services.showMessage(`rewind 已完成，但结果提示保存失败：${message}`, 7000, ownerSessionId);
    }
    applying.set(false);
  }

  function CheckpointPanel() {
    const selectedIndex = micaUi.useScheduleState(checkpointIndex);
    const currentFeedback = micaUi.useScheduleState(feedback);
    const items: SelectItem[] = checkpoints.map((checkpoint) => ({
      key: checkpoint.id,
      label: checkpoint.conversationLabel,
      description: formatSessionListTime(checkpoint.createdAt),
    }));
    return (
      <micaUi.Dialog
        title={`rewind · 选择要回到的用户输入 (${items.length})`}
        footer={<micaUi.KeyHints hints={['↑↓ navigate', '↵ continue', 'esc cancel']} />}
      >
        <micaUi.SelectList items={items} selectedIdx={selectedIndex} layout="table" itemGap={0} />
        {currentFeedback ? <Text color={micaUi.theme.colors.warning}>{currentFeedback}</Text> : null}
      </micaUi.Dialog>
    );
  }

  function ScopePanel({ current }: { current: SuccessfulPreview }) {
    const selectedIndex = micaUi.useScheduleState(modeIndex);
    const currentFeedback = micaUi.useScheduleState(feedback);
    const isApplying = micaUi.useScheduleState(applying);
    const modes = modesFor(current);
    const items: SelectItem[] = modes.map((mode) => ({
      key: mode,
      label:
        mode === 'conversation_only'
          ? '仅回退对话，保留当前文件'
          : current.files.length === 0
            ? '回退对话（没有文件变化）'
            : '回退对话和文件',
      description:
        mode === 'conversation_only'
          ? '原输入将恢复到输入框'
          : `restore ${countActions(current.files, 'restore')} · delete ${countActions(current.files, 'delete')}`,
    }));
    const visibleFiles = current.files.slice(0, MAX_VISIBLE_FILES);
    const hiddenCount = current.files.length - visibleFiles.length;

    return (
      <micaUi.Dialog
        title={isApplying ? 'rewind · applying...' : `rewind · 回到「${current.conversationLabel}」之前`}
        footer={<micaUi.KeyHints hints={['↑↓ choose scope', '↵ rewind', 'esc back']} />}
      >
        <Text color={micaUi.theme.colors.dim}>
          messages: {current.messageCountNow} -&gt; {current.messageCountBefore}；原输入将恢复到输入框
        </Text>
        {!current.fileStateAvailable ? (
          <Text color={micaUi.theme.colors.warning}>
            文件状态不可用，本次只能回退对话：{current.fileStateError ?? 'unknown error'}
          </Text>
        ) : visibleFiles.length > 0 ? (
          <Box flexDirection="column" marginTop={1}>
            <Text color={micaUi.theme.colors.primary}>文件影响：</Text>
            <Text color={micaUi.theme.colors.warning}>文件回退会覆盖内容，并重置这些文件当前的暂存状态。</Text>
            {visibleFiles.map((file) => (
              <Text
                key={file.path}
                color={file.action === 'delete' ? micaUi.theme.colors.warning : undefined}
                wrap="truncate"
              >
                {formatFileChange(file)}
              </Text>
            ))}
            {hiddenCount > 0 ? <Text color={micaUi.theme.colors.dim}>... and {hiddenCount} more</Text> : null}
          </Box>
        ) : (
          <Text color={micaUi.theme.colors.dim}>没有文件变化</Text>
        )}
        <Box flexDirection="column" marginTop={1}>
          <micaUi.SelectList items={items} selectedIdx={selectedIndex} layout="table" itemGap={0} />
        </Box>
        {currentFeedback ? <Text color={micaUi.theme.colors.warning}>{currentFeedback}</Text> : null}
      </micaUi.Dialog>
    );
  }

  function RewindPanel() {
    const currentPhase = micaUi.useScheduleState(phase);
    const currentPreview = micaUi.useScheduleState(preview);
    return currentPhase === 'scope' && currentPreview ? (
      <ScopePanel current={currentPreview} />
    ) : (
      <CheckpointPanel />
    );
  }

  micaUi.panels.setExclusivePluginUI({
    id: PANEL_ID,
    component: RewindPanel,
    preserveInput: true,
    onInput: (_input, key) => {
      if (applying.get()) return true;
      if (key.escape) {
        if (phase.get() === 'scope') {
          phase.set('checkpoint');
          preview.set(null);
          feedback.set(null);
        } else {
          hide();
        }
        return true;
      }
      if (key.return) {
        if (phase.get() === 'checkpoint') openSelectedCheckpoint();
        else confirmSelectedMode();
        return true;
      }
      const direction = selectionDirection(key);
      if (direction) {
        if (phase.get() === 'checkpoint') {
          checkpointIndex.set(moveSelection(checkpointIndex.get(), checkpoints.length, direction));
        } else {
          const current = preview.get();
          if (current) modeIndex.set(moveSelection(modeIndex.get(), modesFor(current).length, direction));
        }
        return true;
      }
      return true;
    },
  });
}

function formatSuccessNotice(result: ReturnType<CommandRuntimeServices['applyRewind']>): string {
  const lines = [
    `**已回退到「${result.conversationLabel}」之前**`,
    '',
    `- 对话：${result.messageCountNow} -> ${result.messageCountBefore}`,
    '- 原输入已恢复到输入框',
  ];
  if (result.mode === 'conversation_only') {
    lines.push('- 文件：保留当前修改');
  } else {
    lines.push(
      `- 文件：恢复 ${countActions(result.files, 'restore')} 个，删除 ${countActions(result.files, 'delete')} 个`,
    );
  }
  if (result.postApplyWarning) lines.push(`- 警告：${result.postApplyWarning}`);
  return lines.join('\n');
}

function formatFileChange(file: RewindFileChange): string {
  return `${file.action} ${file.path}`;
}

function countActions(files: RewindFileChange[], action: RewindFileChange['action']): number {
  return files.filter((file) => file.action === action).length;
}

function showBusyMessage(services: CommandRuntimeServices): boolean {
  if (services.hasBusyAgents?.()) {
    services.showMessage('rewind: agent task still running; wait or abort before rewinding', 5000);
    return true;
  }
  const running = services.listRunningAgents().filter((agent) => isRunningStatus(agent.status));
  if (running.length === 0) return false;
  services.showMessage(`rewind: ${running.length} agent(s) still running; wait or abort before rewinding`, 5000);
  return true;
}

function isRunningStatus(status: { type: string }): boolean {
  return status.type !== 'idle' && status.type !== 'completed' && status.type !== 'error';
}
