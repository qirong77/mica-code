import { basename } from 'node:path';
import React from 'react';
import { micaUi } from '@packages/mica-ui/index.js';
import type { SelectItem } from '@packages/mica-ui/index.js';
import type { CommandAgent } from './services.js';
import type { CommandSessionController } from './services.js';
import { showSelectCommand } from './selectCommand.js';
import { micaLogger } from '@packages/mica-logger/index.js';
import type { CommandRuntimeServices } from './services.js';
import { formatSessionListTime } from '@packages/mica-ui/utils/format.js';

export function createResumeCommand(
  agent: CommandAgent,
  sessionController: CommandSessionController,
  services: CommandRuntimeServices,
) {
  return {
    name: 'resume',
    description: '恢复之前的会话',
    action: (arg) => {
      if (services.isAgentBusy(agent)) {
        micaLogger.logRuntime('plugin.resume', 'blocked:agent_busy', undefined, 'warn');
        services.showMessage('Agent is busy; wait or abort before resuming');
        return;
      }

      const id = arg?.trim();
      if (id) {
        micaLogger.logRuntime('plugin.resume', 'resume_by_id', { id });
        resumeSession(agent, sessionController, services, id);
        return;
      }

      micaLogger.logRuntime('plugin.resume', 'opened');
      showResumeSelector(agent, sessionController, services);
    },
  } satisfies Parameters<typeof micaUi.dropdown.setQuickCommands>[0][number];
}

function showResumeSelector(
  agent: CommandAgent,
  sessionController: CommandSessionController,
  services: CommandRuntimeServices,
) {
  const sessions = sessionController.list(1000);
  micaLogger.logRuntime('plugin.resume', 'selector:ready', { sessions: sessions.length });
  showSelectCommand({
    id: 'select-session',
    title: (currentIdx, total) => `resume sessions (${currentIdx + 1} / ${total})`,
    current: '',
    options: sessions.map((session) => ({
      name: session.id,
      label: session.title,
      status: formatSessionWorkspace(session.cwd),
      description: formatSessionListTime(session.updatedAt),
      suffix: session.model,
      searchField: `${session.title} ${basename(session.cwd)} ${session.model}`,
    })),
    emptyMessage: 'no saved sessions',
    itemGap: 0,
    filterable: true,
    renderItem: renderResumeSessionItem,
    onSelect: (id) => resumeSession(agent, sessionController, services, id),
  });
}

function renderResumeSessionItem(item: SelectItem, isSelected: boolean): React.ReactNode {
  return (
    <micaUi.OneLineItem
      cells={[
        {
          key: 'title',
          content: item.label,
          flexGrow: 1,
          flexShrink: 1,
          minWidth: 20,
          color: isSelected ? micaUi.theme.colors.accent : undefined,
          bold: isSelected,
        },
        {
          key: 'workspace',
          content: item.status,
          width: 24,
          flexShrink: 0,
          color: isSelected ? micaUi.theme.colors.accent : undefined,
          dimColor: !isSelected,
        },
        {
          key: 'time',
          content: item.description,
          width: 16,
          flexShrink: 0,
          color: isSelected ? micaUi.theme.colors.accent : undefined,
          dimColor: !isSelected,
        },
        {
          key: 'model',
          content: item.suffix,
          width: 20,
          flexShrink: 0,
          color: isSelected ? micaUi.theme.colors.accent : undefined,
          dimColor: !isSelected,
        },
      ]}
    />
  );
}

function formatSessionWorkspace(cwd: string): string {
  const workspace = basename(cwd) || cwd;
  return cwd === process.cwd() ? `${workspace} · current` : workspace;
}

function resumeSession(
  agent: CommandAgent,
  sessionController: CommandSessionController,
  services: CommandRuntimeServices,
  id: string,
) {
  micaLogger.logRuntime('plugin.resume', 'resume:start', { id });
  const result = sessionController.resume(id);
  if (result.ok === false) {
    micaLogger.logRuntime('plugin.resume', 'resume:error', { id, message: result.message }, 'error');
    services.showMessage(result.message, 5000);
    return;
  }
  services.syncModelDisplay(agent);
  services.refreshCurrentAgentSessionUi();
  services.showMessage(`Resumed: ${result.session.title}`, 4000);
  micaLogger.logRuntime('plugin.resume', 'resume:done', {
    id,
    title: result.session.title,
    model: result.session.snapshot.model,
  });
}
