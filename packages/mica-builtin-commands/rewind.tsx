import { Box, Text } from '@anthropic/ink';
import { micaLogger } from '@packages/mica-logger/index.js';
import { micaUi } from '@packages/mica-ui/index.js';
import type { CommandRuntimeServices, RewindFileChange, RewindPreviewResult } from './services.js';

const PANEL_ID = 'rewind-confirm-panel';
const MAX_VISIBLE_FILES = 14;

export function createRewindCommand(services: CommandRuntimeServices) {
  return {
    name: 'rewind',
    description: '回退到上一轮对话之前的状态',
    action: () => {
      const running = services.listRunningAgents().filter((agent) => isRunningStatus(agent.status));
      if (running.length > 0) {
        services.showMessage(`rewind: ${running.length} agent(s) still running; wait or abort before rewinding`, 5000);
        return;
      }

      const preview = services.getRewindPreview();
      if (!preview.ok) {
        services.showMessage(preview.message, 4000);
        return;
      }

      micaLogger.logRuntime('plugin.rewind', 'confirm:show', {
        id: preview.id,
        files: preview.files.length,
        messagesBefore: preview.messageCountBefore,
        messagesNow: preview.messageCountNow,
      });
      showRewindConfirmPanel(preview, services);
    },
  } satisfies Parameters<typeof micaUi.dropdown.setQuickCommands>[0][number];
}

function showRewindConfirmPanel(preview: Extract<RewindPreviewResult, { ok: true }>, services: CommandRuntimeServices) {
  function hide() {
    micaUi.panels.removePluginUI(PANEL_ID);
  }

  function confirm() {
    hide();
    try {
      const result = services.applyRewind(preview.id);
      const fileText = result.fileStateAvailable ? `${result.files.length} file(s)` : 'conversation only';
      services.showMessage(`rewind: reverted to before "${result.conversationLabel}" (${fileText})`, 6000);
      micaLogger.logRuntime('plugin.rewind', 'applied', {
        id: result.id,
        files: result.files.length,
        messages: result.messageCount,
        fileStateAvailable: result.fileStateAvailable,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      micaLogger.logRuntime('plugin.rewind', 'error', { message }, 'error');
      services.showMessage(`rewind failed: ${message}`, 6000);
    }
  }

  function RewindConfirmPanel() {
    const visibleFiles = preview.files.slice(0, MAX_VISIBLE_FILES);
    const hiddenCount = Math.max(0, preview.files.length - visibleFiles.length);
    return (
      <micaUi.Dialog title="rewind" footer={<micaUi.KeyHints hints={['y confirm', 'esc cancel']} />}>
        <Box flexDirection="column" marginTop={1}>
          <Text color={micaUi.theme.colors.warning}>确认回退到对话「{preview.conversationLabel}」之前吗？</Text>
          <Text color={micaUi.theme.colors.dim}>
            messages: {preview.messageCountNow} -&gt; {preview.messageCountBefore}
          </Text>
          {!preview.fileStateAvailable ? (
            <Text color={micaUi.theme.colors.warning}>文件状态不可用：{preview.fileStateError ?? 'unknown error'}</Text>
          ) : preview.files.length === 0 ? (
            <Text color={micaUi.theme.colors.dim}>将回退下面的文件：无文件变化</Text>
          ) : (
            <Box flexDirection="column" marginTop={1}>
              <Text color={micaUi.theme.colors.primary}>将回退下面的文件：</Text>
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
          )}
        </Box>
      </micaUi.Dialog>
    );
  }

  micaUi.panels.upsertPluginUI({
    id: PANEL_ID,
    component: RewindConfirmPanel,
    preserveInput: true,
    onInput: (input, key) => {
      if (key.escape) {
        hide();
        micaLogger.logRuntime('plugin.rewind', 'confirm:cancel', { id: preview.id });
        return true;
      }
      if (input.toLowerCase() === 'y') {
        confirm();
        return true;
      }
      return true;
    },
  });
}

function formatFileChange(file: RewindFileChange): string {
  const prefix = file.action === 'delete' ? 'delete' : 'restore';
  return `${prefix} ${file.path}`;
}

function isRunningStatus(status: { type: string }): boolean {
  return status.type !== 'idle' && status.type !== 'completed' && status.type !== 'error';
}
