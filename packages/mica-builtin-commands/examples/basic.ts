import { micaBuiltinCommands } from '../index.js';

const command = micaBuiltinCommands.createAgentsCommand({
  showMessage: console.log,
  isAgentRunning: () => false,
  getCurrentAgentSessionId: () => undefined,
  getCurrentAgent: () => undefined,
  listRunningAgents: () => [],
  newAgentSession: () => ({
    id: 'example',
    index: 1,
    title: 'Example session',
    cwd: process.cwd(),
    providerId: 'example',
    providerName: 'Example',
    model: 'example-model',
    status: 'idle',
    current: true,
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }),
  switchAgentSession: () => ({
    id: 'example',
    index: 1,
    title: 'Example session',
    cwd: process.cwd(),
    providerId: 'example',
    providerName: 'Example',
    model: 'example-model',
    status: 'idle',
    current: true,
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }),
  refreshCurrentAgentSessionUi: () => undefined,
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
