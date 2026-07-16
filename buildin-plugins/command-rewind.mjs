import React from 'react';
import { Box, Text } from '@anthropic/ink';
import { atom } from 'nanostores';
import { micaUi } from '../packages/mica-ui/index.js';
import { formatSessionListTime } from '../packages/mica-ui/utils/format.js';
import { commandHostToken } from '../packages/mica-builtin-commands/commandHost.js';
import { moveSelection, selectionDirection } from '../packages/mica-builtin-commands/shared/commandInput.js';

const PANEL_ID = 'rewind-panel';
const MAX_VISIBLE_FILES = 14;
const element = React.createElement;

export default function setupCommandRewind(ctx) {
  const host = ctx.services.get(commandHostToken);
  host.registerCommand(ctx, createRewindCommand(host.services));
}

export function createRewindCommand(services) {
  return {
    name: 'rewind',
    description: '选择一轮对话，并回退到该节点完成时的状态',
    action(rawArgs) {
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
  };
}

function showRewindPanel(checkpoints, services) {
  const phase = atom('checkpoint');
  const checkpointIndex = atom(0);
  const modeIndex = atom(0);
  const preview = atom(null);
  const feedback = atom(null);
  const applying = atom(false);
  const ownerSessionId = services.getCurrentAgentSessionId();

  function hide() {
    micaUi.panels.removePluginUI(PANEL_ID);
  }

  function setPreview(result, stale = false) {
    if (!result.ok) {
      feedback.set(result.message);
      preview.set(null);
      phase.set('checkpoint');
      return false;
    }
    preview.set(result);
    modeIndex.set(defaultModeIndex(result));
    feedback.set(stale ? '工作区在预览后发生了变化。文件列表已刷新，请重新确认。' : null);
    phase.set('scope');
    return true;
  }

  function openSelectedCheckpoint() {
    const selected = checkpoints[checkpointIndex.get()];
    if (selected) setPreview(services.getRewindPreview(selected.id));
  }

  function refreshStalePreview(id) {
    setPreview(services.getRewindPreview(id), true);
  }

  function confirmSelectedMode() {
    if (applying.get()) return;
    if (showBusyMessage(services)) return;
    const current = preview.get();
    if (!current) return;
    const mode = rewindModes(current)[modeIndex.get()];
    if (!mode) return;

    applying.set(true);
    feedback.set(null);
    let result;
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
    let inputRestoreError;
    try {
      micaUi.terminalInput.text.set(result.inputText);
    } catch (error) {
      inputRestoreError = error instanceof Error ? error.message : String(error);
    }
    try {
      services.showNotice(formatSuccessNotice(result, inputRestoreError), ownerSessionId, {
        command: '/rewind',
        status: result.postApplyWarning || inputRestoreError ? 'warning' : 'success',
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
    const items = checkpoints.map((checkpoint) => ({
      key: checkpoint.id,
      label: checkpoint.conversationLabel,
      description: formatSessionListTime(checkpoint.createdAt),
    }));
    return element(
      micaUi.Dialog,
      {
        title: `rewind · 选择要回到的用户输入 (${items.length})`,
        footer: element(micaUi.KeyHints, { hints: ['↑↓ navigate', '↵ continue', 'esc cancel'] }),
      },
      element(micaUi.SelectList, { items, selectedIdx: selectedIndex, layout: 'table', itemGap: 0 }),
      currentFeedback ? element(Text, { color: micaUi.theme.colors.warning }, currentFeedback) : null,
    );
  }

  function ScopePanel({ current }) {
    const selectedIndex = micaUi.useScheduleState(modeIndex);
    const currentFeedback = micaUi.useScheduleState(feedback);
    const isApplying = micaUi.useScheduleState(applying);
    const modes = rewindModes(current);
    const actionCounts = countFileActions(current.files);
    const items = modes.map((mode) => ({
      key: mode,
      label:
        mode === 'conversation_only'
          ? '仅回退对话，保留当前文件'
          : current.files.length === 0
            ? '回退对话（没有文件变化）'
            : '回退对话和文件',
      description:
        mode === 'conversation_only'
          ? '对话停在所选节点，文件保持当前状态'
          : `restore ${actionCounts.restore} · delete ${actionCounts.delete}`,
    }));
    const visibleFiles = current.files.slice(0, MAX_VISIBLE_FILES);
    const hiddenCount = current.files.length - visibleFiles.length;

    return element(
      micaUi.Dialog,
      {
        title: isApplying ? 'rewind · applying...' : `rewind · 回到「${current.conversationLabel}」`,
        footer: element(micaUi.KeyHints, { hints: ['↑↓ choose scope', '↵ rewind', 'esc back'] }),
      },
      element(
        Text,
        { color: micaUi.theme.colors.dim },
        `messages: ${current.messageCountNow} -> ${current.messageCountBefore}`,
      ),
      renderFileImpact(current, visibleFiles, hiddenCount),
      element(
        Box,
        { flexDirection: 'column', marginTop: 1 },
        element(micaUi.SelectList, { items, selectedIdx: selectedIndex, layout: 'table', itemGap: 0 }),
      ),
      currentFeedback ? element(Text, { color: micaUi.theme.colors.warning }, currentFeedback) : null,
    );
  }

  function RewindPanel() {
    const currentPhase = micaUi.useScheduleState(phase);
    const currentPreview = micaUi.useScheduleState(preview);
    return currentPhase === 'scope' && currentPreview
      ? element(ScopePanel, { current: currentPreview })
      : element(CheckpointPanel);
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
          if (current) modeIndex.set(moveSelection(modeIndex.get(), rewindModes(current).length, direction));
        }
        return true;
      }
      return true;
    },
  });
}

function renderFileImpact(current, visibleFiles, hiddenCount) {
  if (!current.fileStateAvailable) {
    return element(
      Text,
      { color: micaUi.theme.colors.warning },
      `文件状态不可用，本次只能回退对话：${current.fileStateError ?? 'unknown error'}`,
    );
  }
  if (visibleFiles.length === 0) {
    return element(Text, { color: micaUi.theme.colors.dim }, '没有文件变化');
  }
  return element(
    Box,
    { flexDirection: 'column', marginTop: 1 },
    element(Text, { color: micaUi.theme.colors.primary }, '文件影响：'),
    element(Text, { color: micaUi.theme.colors.warning }, '文件回退会覆盖内容，并重置这些文件当前的暂存状态。'),
    ...visibleFiles.map((file) =>
      element(
        Text,
        {
          key: file.path,
          color: file.action === 'delete' ? micaUi.theme.colors.warning : undefined,
          wrap: 'truncate',
        },
        formatFileChange(file),
      ),
    ),
    hiddenCount > 0 ? element(Text, { color: micaUi.theme.colors.dim }, `... and ${hiddenCount} more`) : null,
  );
}

function formatSuccessNotice(result, inputRestoreError) {
  const actionCounts = countFileActions(result.files);
  const lines = [
    `**已回退到「${result.conversationLabel}」**`,
    '',
    `- 对话：${result.messageCountNow} -> ${result.messageCountBefore}`,
    '- 对话已停在所选节点',
  ];
  if (inputRestoreError) lines.push(`- 警告：原输入恢复失败：${inputRestoreError}`);
  else lines.push('- 原输入已恢复到输入框');
  if (result.mode === 'conversation_only') {
    lines.push('- 文件：保留当前修改');
  } else {
    lines.push(`- 文件：恢复 ${actionCounts.restore} 个，删除 ${actionCounts.delete} 个`);
  }
  if (result.postApplyWarning) lines.push(`- 警告：${result.postApplyWarning}`);
  return lines.join('\n');
}

function formatFileChange(file) {
  return `${file.action} ${file.path}`;
}

function rewindModes(currentPreview) {
  return currentPreview.fileStateAvailable ? ['conversation_only', 'conversation_and_files'] : ['conversation_only'];
}

function defaultModeIndex(currentPreview) {
  return currentPreview.fileStateAvailable && currentPreview.files.every((file) => file.action !== 'delete') ? 1 : 0;
}

function countFileActions(files) {
  const counts = { restore: 0, delete: 0 };
  for (const file of files) counts[file.action] += 1;
  return counts;
}

function showBusyMessage(services) {
  if (services.hasBusyAgents?.()) {
    services.showMessage('rewind: agent task still running; wait or abort before rewinding', 5000);
    return true;
  }
  const running = services.listRunningAgents().filter((agent) => isRunningStatus(agent.status));
  if (running.length === 0) return false;
  services.showMessage(`rewind: ${running.length} agent(s) still running; wait or abort before rewinding`, 5000);
  return true;
}

function isRunningStatus(status) {
  return status.type !== 'idle' && status.type !== 'completed' && status.type !== 'error';
}
