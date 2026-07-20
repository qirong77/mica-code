import { basename } from 'node:path';
import React from 'react';
import { Box, Text } from '@anthropic/ink';
import { atom } from 'nanostores';
import { micaUi } from '../packages/mica-ui/index.js';
import { formatSessionListTime } from '../packages/mica-ui/utils/format.js';
import { commandHostToken } from '../packages/mica-builtin-commands/commandHost.js';
import { moveSelection, selectionDirection } from '../packages/mica-builtin-commands/shared/commandInput.js';

const element = React.createElement;

export default function setupCommandResume(ctx) {
  const host = ctx.services.get(commandHostToken);
  host.registerCommand(ctx, createResumeCommand(host.agent, host.sessionController, host.services));
}

export function createResumeCommand(agent, sessionController, services) {
  return {
    name: 'resume',
    description: '恢复之前的会话',
    async action(arg) {
      if (services.isAgentBusy(agent)) {
        services.showMessage('Agent is busy; wait or abort before resuming');
        return;
      }

      const id = arg?.trim();
      if (id) {
        await resumeSession(agent, sessionController, services, id);
        return;
      }
      showResumeSelector(agent, sessionController, services);
    },
  };
}

function showResumeSelector(agent, sessionController, services) {
  const sessions = sessionController.list(1000);
  const filter = atom('cwd');
  const query = atom('');
  const selectedIdx = atom(0);

  function visibleSessions() {
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
    void resumeSession(agent, sessionController, services, session.id);
  }

  function ResumePanel() {
    const currentFilter = micaUi.useScheduleState(filter);
    const currentIdx = micaUi.useScheduleState(selectedIdx);
    micaUi.useScheduleState(query);
    const visible = visibleSessions();
    const items = visible.map((session) => ({
      key: session.id,
      label: formatResumeSessionTitle(session),
      description: formatSessionListTime(session.updatedAt),
    }));
    const title = element(
      Text,
      { dimColor: true },
      `resume sessions (${items.length}) Filter:  `,
      element(
        Text,
        {
          color: currentFilter === 'cwd' ? micaUi.theme.colors.accent : undefined,
          bold: currentFilter === 'cwd',
        },
        currentFilter === 'cwd' ? '[Cwd]' : 'Cwd',
      ),
      '   ',
      element(
        Text,
        {
          color: currentFilter === 'all' ? micaUi.theme.colors.accent : undefined,
          bold: currentFilter === 'all',
        },
        currentFilter === 'all' ? '[All]' : 'All',
      ),
    );

    return element(
      micaUi.Dialog,
      {
        title,
        footer: element(micaUi.KeyHints, {
          hints: ['type to search', '↑↓ navigate', 'tab filter', '↵ resume', 'esc cancel'],
        }),
      },
      element(micaUi.SelectList, {
        items,
        selectedIdx: currentIdx,
        empty: element(Text, { dimColor: true }, query.get() ? 'no matching sessions' : 'no saved sessions'),
        itemGap: 0,
        layout: 'table',
        renderItem: renderResumeSessionItem,
      }),
    );
  }

  micaUi.terminalInput.clearText();
  micaUi.panels.setExclusivePluginUI({
    id: 'select-session',
    component: ResumePanel,
    preserveInput: true,
    onTextChange(text) {
      query.set(text);
      selectedIdx.set(0);
      return true;
    },
    onInput(_input, key) {
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

export function formatResumeSessionTitle(session) {
  return session.uncompleted ? `（uncompleted）${session.title}` : session.title;
}

function renderResumeSessionItem(item, isSelected, index) {
  return element(
    Box,
    {
      width: '100%',
      backgroundColor: isSelected
        ? micaUi.theme.colors.listRowSelected
        : index % 2
          ? micaUi.theme.colors.listRowAlternate
          : micaUi.theme.colors.listRow,
    },
    element(micaUi.OneLineItem, {
      cells: [
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
      ],
    }),
  );
}

async function resumeSession(agent, sessionController, services, id) {
  const session = sessionController.load?.(id);
  if (sessionController.load && !session) {
    services.showMessage(`Session not found: ${id}`, 5000);
    return;
  }
  if (session && services.ensureModelRule) {
    try {
      await services.ensureModelRule(session.snapshot.model);
    } catch (error) {
      services.showMessage(error instanceof Error ? error.message : String(error), 5000);
      return;
    }
  }
  const result = sessionController.resume(id);
  if (result.ok === false) {
    services.showMessage(result.message, 5000);
    return;
  }
  services.clearRewindCheckpoints?.();
  services.syncModelDisplay(agent);
  services.refreshCurrentAgentSessionUi();
  const roleMessage = result.roleFallback
    ? `; role ${result.roleFallback.missing} not found, using ${result.roleFallback.fallback}`
    : '';
  services.showMessage(`Resumed: ${result.session.title}${roleMessage}`, roleMessage ? 7000 : 4000);
}
