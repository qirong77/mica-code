import { micaPlugin, type PluginContext } from '../index.js';

class DemoPlugin extends micaPlugin.Plugin {
  constructor() {
    super({ id: 'demo.plugin', name: 'Demo Plugin' });
  }

  setup(ctx: PluginContext) {
    const disposable = ctx.hooks.on('demo:event', () => {
      ctx.logger.info('demo:event');
    });
    ctx.onDispose(() => disposable.dispose());
  }
}

console.log(new DemoPlugin().id);
