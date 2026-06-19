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
      return { text: 'connecting', color: themeColors.textSecondary, spinning: true };
    case 'thinking':
      return { text: 'thinking', color: themeColors.textSecondary, spinning: true };
    case 'streaming':
      return { text: 'streaming', color: themeColors.textSecondary, spinning: true };
    case 'calling_tool': {
      const base = status.toolNames?.length ? status.toolNames.join(', ') : 'calling_tool';
      const elapsed = status.elapsedMs != null ? ` ${formatElapsed(status.elapsedMs)}` : '';
      return { text: `${base}${elapsed}`, color: themeColors.textSecondary, spinning: true };
    }
    case 'plugin_task':
      return {
        text: status.text,
        color:
          status.level === 'error'
            ? themeColors.error
            : status.level === 'warn'
              ? themeColors.warning
              : themeColors.textSecondary,
        spinning: true,
      };
    case 'completed': {
      const elapsed = status.elapsedMs != null ? ` ${formatElapsed(status.elapsedMs)}` : '';
      return { text: `completed${elapsed}`, color: themeColors.success, spinning: false };
    }
    case 'error':
      return { text: status.message ? `error: ${status.message}` : 'error', color: themeColors.error, spinning: false };
    case 'idle':
      return { text: 'idle', color: themeColors.dim, spinning: false };
  }
}
