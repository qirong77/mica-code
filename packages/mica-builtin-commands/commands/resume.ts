import { basename } from 'node:path';
import React from 'react';
import { Box, Text } from '@anthropic/ink';
import { atom } from 'nanostores';
import { micaUi } from '@packages/mica-ui/index.js';
import { formatSessionListTime } from '@packages/mica-ui/utils/format.js';
import type { BuiltInCommandItem } from '../commandHost.js';
import { moveSelection, selectionDirection } from '../shared/commandInput.js';
import type { CommandAgent, CommandRuntimeServices, CommandSessionController, SessionSummary } from '../services.js';

const element = React.createElement;

export function createResumeCommand(
  agent: CommandAgent,
  sessionController: CommandSessionController,
  services: CommandRuntimeServices,
): BuiltInCommandItem {
  return {
    name: 'resume',
    description: '恢复之前的会话',
    async action(arg) {
      if (services.isAgentBusy(agent)) {
        services.showNotice('Agent is busy; wait or abort before resuming', undefined, {
          command: '/resume',
          status: 'warning',
        });
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

function showResumeSelector(
  agent: CommandAgent,
  sessionController: CommandSessionController,
  services: CommandRuntimeServices,
) {
  const sessions = sessionController.list(1000);
  const filter = atom('cwd');
  const query = atom('');
  const selectedIdx = atom(0);

  function visibleSessions(): ResumeRow[] {
    const normalizedQuery = query.get().trim().toLowerCase();
    const filtered = sessions
      .filter((session) => {
        if (filter.get() === 'cwd' && session.cwd !== process.cwd()) return false;
        if (!normalizedQuery) return true;
        return `${formatResumeSessionTitle(session)} ${basename(session.cwd)} ${session.cwd} ${session.model}`
          .toLowerCase()
          .includes(normalizedQuery);
      })
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    return arrangeResumeSessions(filtered);
  }

  function hide() {
    micaUi.terminalInput.clearText();
    micaUi.panels.clearPluginUIs();
  }

  function selectCurrent() {
    const session = visibleSessions()[selectedIdx.get()]?.session;
    if (!session) return;
    hide();
    void resumeSession(agent, sessionController, services, session.id);
  }

  function ResumePanel() {
    const currentFilter = micaUi.useScheduleState(filter);
    const currentIdx = micaUi.useScheduleState(selectedIdx);
    micaUi.useScheduleState(query);
    const visible = visibleSessions();
    const items = visible.map(({ session, depth }) => ({
      key: session.id,
      label: `${'  '.repeat(depth)}${depth ? '↳ ' : ''}${formatResumeSessionTitle(session)}`,
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

    return element(micaUi.Dialog, {
      title,
      footer: element(micaUi.KeyHints, {
        hints: ['type to search', '↑↓ navigate', 'tab filter', '↵ resume', 'esc cancel'],
      }),
      children: element(micaUi.SelectList, {
        items,
        selectedIdx: currentIdx,
        empty: element(Text, { dimColor: true }, query.get() ? 'no matching sessions' : 'no saved sessions'),
        itemGap: 0,
        layout: 'table',
        renderItem: renderResumeSessionItem,
      }),
    });
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

type ResumeSession = SessionSummary & { parentSessionId?: string };
type ResumeRow = { session: ResumeSession; depth: number };

/** Input is already sorted; preserve that order among roots and siblings. */
export function arrangeResumeSessions(sessions: ResumeSession[]): ResumeRow[] {
  const byId = new Map(sessions.map((session) => [session.id, session]));
  const parentById = new Map<string, string>();
  for (const session of sessions) {
    const parent = session.parentSessionId;
    if (parent && byId.has(parent)) parentById.set(session.id, parent);
  }

  // Break every edge in a cycle. Descendants can still follow their parent,
  // while malformed records remain selectable as independent roots.
  const checked = new Set<string>();
  for (const session of sessions) {
    const path: string[] = [];
    const positions = new Map<string, number>();
    let id: string | undefined = session.id;
    while (id && !checked.has(id)) {
      const cycleStart = positions.get(id);
      if (cycleStart !== undefined) {
        for (const cycleId of path.slice(cycleStart)) parentById.delete(cycleId);
        break;
      }
      positions.set(id, path.length);
      path.push(id);
      id = parentById.get(id);
    }
    for (const visited of path) checked.add(visited);
  }

  const children = new Map<string, ResumeSession[]>();
  const roots: ResumeSession[] = [];
  for (const session of sessions) {
    const parent = parentById.get(session.id);
    if (!parent) roots.push(session);
    else {
      const siblings = children.get(parent) ?? [];
      siblings.push(session);
      children.set(parent, siblings);
    }
  }
  const rows: ResumeRow[] = [];
  const pending = roots.slice().reverse().map((session) => ({ session, depth: 0 }));
  while (pending.length) {
    const row = pending.pop()!;
    rows.push(row);
    const descendants = children.get(row.session.id) ?? [];
    for (let i = descendants.length - 1; i >= 0; i--) {
      pending.push({ session: descendants[i]!, depth: row.depth + 1 });
    }
  }
  return rows;
}

export function formatResumeSessionTitle(session: Pick<SessionSummary, 'title' | 'uncompleted'>): string {
  return session.uncompleted ? `（uncompleted）${session.title}` : session.title;
}

function renderResumeSessionItem(item: { description?: unknown; label: unknown }, isSelected: boolean, index: number) {
  const description = item.description === undefined ? '' : String(item.description);
  const label = item.label === undefined ? '' : String(item.label);
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
          content: description,
          width: 16,
          flexShrink: 0,
          color: isSelected ? micaUi.theme.colors.accent : undefined,
          dimColor: !isSelected,
        },
        {
          key: 'title',
          content: label,
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

async function resumeSession(
  agent: CommandAgent,
  sessionController: CommandSessionController,
  services: CommandRuntimeServices,
  id: string,
) {
  const session = sessionController.load?.(id);
  if (sessionController.load && !session) {
    services.showNotice(`Session not found: ${id}`, undefined, { command: '/resume', status: 'warning' });
    return;
  }
  if (session && services.ensureModelRule) {
    try {
      await services.ensureModelRule(session.snapshot.model);
    } catch (error) {
      services.showNotice(error instanceof Error ? error.message : String(error), undefined, {
        command: '/resume',
        status: 'error',
      });
      return;
    }
  }
  const result = sessionController.resume(id);
  if (result.ok === false) {
    services.showNotice(result.message, undefined, { command: '/resume', status: 'error' });
    return;
  }
  const cwd = switchToSessionCwd(result.session.cwd, services);
  services.clearRewindCheckpoints?.();
  services.syncModelDisplay(agent);
  services.refreshCurrentAgentSessionUi();
  const roleMessage = result.roleFallback
    ? `; role ${result.roleFallback.missing} not found, using ${result.roleFallback.fallback}`
    : '';
  services.showNotice(`Resumed: ${result.session.title}${cwd.text}${roleMessage}`, undefined, {
    command: '/resume',
    status: roleMessage || cwd.failed ? 'warning' : 'success',
  });
}

/**
 * A session owns its working directory: tools, AGENT.md, skills and the cwd
 * written back on save all read `process.cwd()`, so resuming elsewhere would
 * silently move the session to the launch directory.
 */
function switchToSessionCwd(
  cwd: string | undefined,
  services: CommandRuntimeServices,
): { text: string; failed: boolean } {
  if (!cwd || cwd === process.cwd()) return { text: '', failed: false };
  try {
    process.chdir(cwd);
    services.syncAgentStatusItems?.();
    return { text: `; cwd ${process.cwd()}`, failed: false };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { text: `; cwd not switched (${message})`, failed: true };
  }
}
