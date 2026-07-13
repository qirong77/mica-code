import { basename } from 'node:path';
import React from 'react';
import { Box, Text } from '@anthropic/ink';
import { atom } from 'nanostores';
import { micaUi } from '@packages/mica-ui/index.js';
import type { SelectItem } from '@packages/mica-ui/index.js';
import type { CommandAgent } from './services.js';
import type { CommandSessionController } from './services.js';
import type { CommandRuntimeServices } from './services.js';
import type { SessionSummary } from './services.js';
import { moveSelection, selectionDirection } from './commandInput.js';
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
        services.showMessage('Agent is busy; wait or abort before resuming');
        return;
      }

      const id = arg?.trim();
      if (id) {
        resumeSession(agent, sessionController, services, id);
        return;
      }
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
  const filter = atom<'cwd' | 'all'>('cwd');
  const query = atom('');
  const selectedIdx = atom(0);

  function visibleSessions(): SessionSummary[] {
    const normalizedQuery = query.get().trim().toLowerCase();
    return sessions.filter((session) => {
      if (filter.get() === 'cwd' && session.cwd !== process.cwd()) return false;
      if (!normalizedQuery) return true;
      return `${formatResumeSessionTitle(session)} ${basename(session.cwd)} ${session.cwd} ${session.model}`
        .toLowerCase()
        .includes(normalizedQuery);
    });
  }

  function hide() {
    micaUi.terminalInput.clearText();
    micaUi.panels.clearPluginUIs();
  }

  function selectCurrent() {
    const session = visibleSessions()[selectedIdx.get()];
    if (!session) return;
    hide();
    resumeSession(agent, sessionController, services, session.id);
  }

  function ResumePanel() {
    const currentFilter = micaUi.useScheduleState(filter);
    const currentIdx = micaUi.useScheduleState(selectedIdx);
    micaUi.useScheduleState(query);
    const visible = visibleSessions();
    const items: SelectItem[] = visible.map((session) => ({
      key: session.id,
      label: formatResumeSessionTitle(session),
      description: formatSessionListTime(session.updatedAt),
    }));

    return (
      <micaUi.Dialog
        title={
          <Text dimColor>
            resume sessions ({items.length}) Filter:{'  '}
            <Text
              color={currentFilter === 'cwd' ? micaUi.theme.colors.accent : undefined}
              bold={currentFilter === 'cwd'}
            >
              {currentFilter === 'cwd' ? '[Cwd]' : 'Cwd'}
            </Text>
            {'   '}
            <Text
              color={currentFilter === 'all' ? micaUi.theme.colors.accent : undefined}
              bold={currentFilter === 'all'}
            >
              {currentFilter === 'all' ? '[All]' : 'All'}
            </Text>
          </Text>
        }
        footer={<micaUi.KeyHints hints={['type to search', '↑↓ navigate', 'tab filter', '↵ resume', 'esc cancel']} />}
      >
        <micaUi.SelectList
          items={items}
          selectedIdx={currentIdx}
          empty={<Text dimColor>{query.get() ? 'no matching sessions' : 'no saved sessions'}</Text>}
          itemGap={0}
          layout="table"
          renderItem={renderResumeSessionItem}
        />
      </micaUi.Dialog>
    );
  }

  micaUi.terminalInput.clearText();
  micaUi.panels.setExclusivePluginUI({
    id: 'select-session',
    component: ResumePanel,
    preserveInput: true,
    onTextChange: (text) => {
      query.set(text);
      selectedIdx.set(0);
      return true;
    },
    onInput: (_input, key) => {
      if (key.escape) {
        hide();
        return true;
      }
      if (key.tab) {
        filter.set(filter.get() === 'cwd' ? 'all' : 'cwd');
        selectedIdx.set(0);
        return true;
      }
      if (key.return) {
        selectCurrent();
        return true;
      }
      const direction = selectionDirection(key);
      if (direction) {
        const count = visibleSessions().length;
        if (count > 0) selectedIdx.set(moveSelection(selectedIdx.get(), count, direction));
        return true;
      }
      return false;
    },
  });
}

export function formatResumeSessionTitle(session: Pick<SessionSummary, 'title' | 'uncompleted'>): string {
  return session.uncompleted ? `（uncompleted）${session.title}` : session.title;
}

function renderResumeSessionItem(item: SelectItem, isSelected: boolean, index: number): React.ReactNode {
  return (
    <Box width="100%" backgroundColor={isSelected ? '#3A3A3A' : index % 2 ? '#303030' : '#292929'}>
      <micaUi.OneLineItem
        cells={[
          {
            key: 'time',
            content: item.description,
            width: 16,
            flexShrink: 0,
            color: isSelected ? micaUi.theme.colors.accent : undefined,
            dimColor: !isSelected,
          },
          {
            key: 'title',
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

function resumeSession(
  agent: CommandAgent,
  sessionController: CommandSessionController,
  services: CommandRuntimeServices,
  id: string,
) {
  const result = sessionController.resume(id);
  if (result.ok === false) {
    services.showMessage(result.message, 5000);
    return;
  }
  services.syncModelDisplay(agent);
  services.refreshCurrentAgentSessionUi();
  const roleMessage = result.roleFallback
    ? `; role ${result.roleFallback.missing} not found, using ${result.roleFallback.fallback}`
    : '';
  services.showMessage(`Resumed: ${result.session.title}${roleMessage}`, roleMessage ? 7000 : 4000);
}
