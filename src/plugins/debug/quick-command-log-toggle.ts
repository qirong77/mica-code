import { MicaPlugin } from '../MicaPlugin';
import { systemLogVisibleAtom, quickCommandsAtom } from '../../store/ui-state.js';

export class QuickCommandLogTogglePlugin extends MicaPlugin {
  onInstall(): void {
    this.addQuickCommand({
      name: 'debug-log-open',
      description: '打开系统日志面板',
      hidden: true,
      action: () => {
        const visible = systemLogVisibleAtom.get();
        systemLogVisibleAtom.set(!visible);

        const commands = quickCommandsAtom.get();
        quickCommandsAtom.set(
          commands.map((cmd) => {
            if (cmd.name === 'debug-log-open' || cmd.name === 'debug-log-close') {
              return {
                ...cmd,
                name: visible ? 'debug-log-open' : 'debug-log-close',
                description: visible ? '打开系统日志面板' : '关闭系统日志面板',
              };
            }
            return cmd;
          }),
        );
      },
    });
  }
}
