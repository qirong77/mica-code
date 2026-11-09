import { expect, it } from 'vitest';
import { getToolIcon } from './agentTurnLogItems.js';

it('uses the robot icon for current and legacy agent tool names', () => {
  expect(getToolIcon('agent')).toBe('🤖');
  expect(getToolIcon('Agent')).toBe('🤖');
});
