import { basename } from 'node:path';
import { useEffect, useMemo, useState } from 'react';
import { useTerminalTitle } from '@anthropic/ink';
import { RUNTIME_NAME } from '@packages/mica-config/brand.js';
import { runtimeEnv } from '@packages/mica-config/runtimeEnv.js';
import { useScheduleState } from '../hooks/useScheduleState.js';
import { agentStatusItems, workingStatus } from '../panels/state.js';
import type { MicaUiAgentStatusItem, MicaUiWorkingStatus } from '../types.js';

const VSCODE_AGENT_CLI_PROBE_TITLE = 'Claude Code';
const RUNNING_TITLE_PREFIXES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'] as const;

const RUNNING_STATUS_TYPES = new Set<MicaUiWorkingStatus['type']>([
  'connecting',
  'thinking',
  'streaming',
  'calling_tool',
  'plugin_task',
]);

function isRunningStatus(status: MicaUiWorkingStatus): boolean {
  return RUNNING_STATUS_TYPES.has(status.type);
}

function currentCwdBase(items: readonly MicaUiAgentStatusItem[]): string {
  const current = items.find((item) => item.current);
  const cwd = current?.cwd || process.cwd();
  return basename(cwd);
}

export function getTerminalTitle(status: MicaUiWorkingStatus, animationFrame = 0, cwdBase = ''): string {
  const base = cwdBase ? `${RUNTIME_NAME}/${cwdBase}` : RUNTIME_NAME;
  if (isRunningStatus(status)) return `${RUNNING_TITLE_PREFIXES[animationFrame % RUNNING_TITLE_PREFIXES.length]} ${base}`;
  if (status.type === 'completed') return `✓ ${base}`;
  if (status.type === 'error') return `✕ ${base}`;
  return base;
}

export function TerminalTitle(): null {
  const status = useScheduleState(workingStatus);
  const items = useScheduleState(agentStatusItems);
  const running = isRunningStatus(status);
  const [animationFrame, setAnimationFrame] = useState(0);
  const cwdBase = useMemo(() => currentCwdBase(items), [items]);

  useEffect(() => {
    if (!running) return;

    setAnimationFrame(0);
    const timer = setInterval(
      () => setAnimationFrame((frame) => (frame + 1) % RUNNING_TITLE_PREFIXES.length),
      runtimeEnv.ui.spinnerFrameIntervalMs,
    );
    return () => clearInterval(timer);
  }, [running]);

  // VS Code currently applies OSC titles automatically only to a hard-coded
  // set of agent CLIs. Claude Code is detected from this initial OSC title.
  // Send the same one-shot probe before Mica's real title so VS Code switches
  // the tab to sequence titles; both writes happen in the same effect flush.
  useTerminalTitle(process.env.TERM_PROGRAM === 'vscode' ? VSCODE_AGENT_CLI_PROBE_TITLE : null);
  useTerminalTitle(getTerminalTitle(status, animationFrame, cwdBase));
  return null;
}
