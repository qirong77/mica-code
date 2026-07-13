import { useEffect, useState } from 'react';
import { useTerminalTitle } from '@anthropic/ink';
import { runtimeEnv } from '@packages/mica-config/runtimeEnv.js';
import { useScheduleState } from '../hooks/useScheduleState.js';
import { workingStatus } from '../panels/state.js';
import type { MicaUiWorkingStatus } from '../types.js';

const VSCODE_AGENT_CLI_PROBE_TITLE = 'Claude Code';
const RUNNING_TITLE_FRAMES = [
  '⠋ Mica',
  '⠙ Mica',
  '⠹ Mica',
  '⠸ Mica',
  '⠼ Mica',
  '⠴ Mica',
  '⠦ Mica',
  '⠧ Mica',
  '⠇ Mica',
  '⠏ Mica',
] as const;

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

export function getTerminalTitle(status: MicaUiWorkingStatus, animationFrame = 0): string {
  if (isRunningStatus(status)) return RUNNING_TITLE_FRAMES[animationFrame % RUNNING_TITLE_FRAMES.length];
  if (status.type === 'completed') return '✓ Mica';
  if (status.type === 'error') return '✕ Mica';
  return 'Mica';
}

export function TerminalTitle(): null {
  const status = useScheduleState(workingStatus);
  const running = isRunningStatus(status);
  const [animationFrame, setAnimationFrame] = useState(0);

  useEffect(() => {
    if (!running) return;

    setAnimationFrame(0);
    const timer = setInterval(
      () => setAnimationFrame((frame) => (frame + 1) % RUNNING_TITLE_FRAMES.length),
      runtimeEnv.ui.spinnerFrameIntervalMs,
    );
    return () => clearInterval(timer);
  }, [running]);

  // VS Code currently applies OSC titles automatically only to a hard-coded
  // set of agent CLIs. Claude Code is detected from this initial OSC title.
  // Send the same one-shot probe before Mica's real title so VS Code switches
  // the tab to sequence titles; both writes happen in the same effect flush.
  useTerminalTitle(process.env.TERM_PROGRAM === 'vscode' ? VSCODE_AGENT_CLI_PROBE_TITLE : null);
  useTerminalTitle(getTerminalTitle(status, animationFrame));
  return null;
}
