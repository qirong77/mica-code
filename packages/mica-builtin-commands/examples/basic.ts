import { micaBuiltinCommands } from '../index.js';

const command = micaBuiltinCommands.createAgentsCommand({
  showMessage: console.log,
  isAgentRunning: () => false,
  listRunningAgents: () => [],
  attachAgent: async () => 'attached',
  detachAgent: async () => 'detached',
  clearUI: () => undefined,
  syncModelDisplay: () => undefined,
  compact: async () => ({
    beforeCount: 4,
    afterCount: 1,
    beforeTokenEstimate: 100,
    afterTokenEstimate: 25,
  }),
});

console.log(`/${command.name}: ${command.description}`);
