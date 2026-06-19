import { micaIpc } from '@packages/mica-ipc/index.js';
import { micaPlugin, type PluginContext } from '@packages/mica-plugin/index.js';
import type { LocalRuntimeController } from '../../app/adapters/LocalRuntimeController.js';
import type { AgentRegistry } from '../../agents/agentRegistry.js';

export class IpcServerPlugin extends micaPlugin.Plugin {
  private server: InstanceType<typeof micaIpc.AgentIpcServer> | null = null;

  constructor(
    private readonly registry: AgentRegistry,
    private readonly runtime: LocalRuntimeController,
  ) {
    super({
      id: 'builtin.ipc.server',
      name: 'IPC Server',
    });
  }

  setup(ctx: PluginContext): void {
    const startDisposable = ctx.hooks.on(
      'runtime:start',
      async () => {
        this.server = new micaIpc.AgentIpcServer({
          agentId: this.registry.id,
          socketPath: this.registry.socketPath,
          runtime: this.runtime,
          onControlChanged: (state) => this.registry.setControl(state),
        });
        await this.server.start();
      },
      { pluginId: ctx.pluginId, failPolicy: 'stop' },
    );
    ctx.onDispose(() => startDisposable.dispose());

    const stopDisposable = ctx.hooks.on(
      'runtime:stop',
      async () => {
        await this.server?.stop();
        this.server = null;
      },
      { pluginId: ctx.pluginId },
    );
    ctx.onDispose(() => stopDisposable.dispose());
  }
}
