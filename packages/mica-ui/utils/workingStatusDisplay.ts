import type { MicaUiWorkingStatus } from '../types.js';
import { themeColors } from '../theme.js';
import { formatElapsed } from './format.js';

export type WorkingStatusDisplay = {
  text: string;
  color: string;
  spinning: boolean;
};

export function getWorkingStatusDisplay(status: MicaUiWorkingStatus): WorkingStatusDisplay {
  switch (status.type) {
    case 'connecting':
      return { text: 'waiting_model', color: themeColors.statusRunning, spinning: true };
    case 'thinking':
      return { text: 'thinking', color: themeColors.statusRunning, spinning: true };
    case 'streaming':
      return { text: 'streaming', color: themeColors.statusRunning, spinning: true };
    case 'calling_tool': {
      const base = status.toolNames?.length ? status.toolNames.join(', ') : 'calling_tool';
      const elapsed = status.elapsedMs != null ? ` ${formatElapsed(status.elapsedMs)}` : '';
      return { text: `${base}${elapsed}`, color: themeColors.statusRunning, spinning: true };
    }
    case 'retrying': {
      const attempt = status.attempt != null ? ` ${status.attempt}` : '';
      return { text: `retrying${attempt}`, color: themeColors.statusWarning, spinning: true };
    }
    case 'plugin_task':
      return {
        text: status.text,
        color:
          status.level === 'error'
            ? themeColors.statusError
            : status.level === 'warn'
              ? themeColors.statusWarning
              : themeColors.statusRunning,
        spinning: true,
      };
    case 'completed': {
      const elapsed = status.elapsedMs != null ? ` ${formatElapsed(status.elapsedMs)}` : '';
      return { text: `completed${elapsed}`, color: themeColors.statusSuccess, spinning: false };
    }
    case 'error':
      return { text: 'error', color: themeColors.statusError, spinning: false };
    case 'idle':
      return { text: 'idle', color: themeColors.inactive, spinning: false };
  }
}

export function getWorkingStatusTotalElapsed(status: MicaUiWorkingStatus, now = Date.now()): string {
  const startedAt = getActiveTurnStartedAt(status);
  if (startedAt == null) return '';
  return formatElapsed(Math.max(0, now - startedAt));
}

function getActiveTurnStartedAt(status: MicaUiWorkingStatus): number | undefined {
  switch (status.type) {
    case 'connecting':
    case 'thinking':
    case 'streaming':
    case 'calling_tool':
    case 'retrying':
      return status.startedAt;
    default:
      return undefined;
  }
}
