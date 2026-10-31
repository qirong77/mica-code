import { describe, expect, it, vi } from 'vitest';
import type { TerminalAgentSession } from '../agents/terminalAgentSessions.js';
import { resolvePluginSession } from './pluginSessionOwner.js';

describe('plugin session owner', () => {
  it('uses the selected session only when no explicit owner was supplied', () => {
    const selected = { id: 'selected' } as TerminalAgentSession;
    const origin = { id: 'origin' } as TerminalAgentSession;
    const owner = {};
    const current = vi.fn(() => selected);
    const sessions = { current, findByAgent: vi.fn((agent) => agent === owner ? origin : undefined) };
    expect(resolvePluginSession(sessions, undefined)).toBe(selected);
    expect(resolvePluginSession(sessions, owner)).toBe(origin);
    expect(resolvePluginSession(sessions, {})).toBeUndefined();
    expect(current).toHaveBeenCalledTimes(1);
  });
});
