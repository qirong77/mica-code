import { micaCommands } from '../index.js';

const commands = new micaCommands.CommandRegistry();
commands.register({
  name: 'hello',
  pluginId: 'example',
  handler: (_ctx, args) => {
    console.log(`hello ${args || 'mica'}`);
  },
});

await commands.execute('/hello command');
