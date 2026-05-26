import { MicaPlugin } from '../MicaPlugin';

export class QuickCommandLogTogglePlugin extends MicaPlugin {
  onInstall(): void {
    this.addQuickCommand({
      name: 'debug-log-open',
      description: '打开系统日志面板',
      hidden: true,
      action: () => {
        const visible = this.atoms.systemLogVisible.get();
        this.atoms.systemLogVisible.set(!visible);

        const commands = this.atoms.quickCommands.get();
        this.atoms.quickCommands.set(
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
