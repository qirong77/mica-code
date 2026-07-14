import { describe, expect, it, vi } from 'vitest';
import type { ConnectedMcpServer } from './client.js';
import { connections } from './client.js';
import { fetchToolsForServer } from './tools.js';

describe('MCP proxy tools', () => {
  it('forwards the agent abort signal to tools/list and tools/call', async () => {
    const controller = new AbortController();
    const request = vi.fn(async (..._args: unknown[]) => ({
      tools: [{ name: 'lookup', description: 'Lookup', inputSchema: { type: 'object' } }],
    }));
    const callTool = vi.fn(async (..._args: unknown[]) => ({ content: [{ type: 'text', text: 'ok' }] }));
    const server = {
      name: 'test',
      config: { command: 'test' },
      cleanup: async () => undefined,
      client: { request, callTool },
    } as unknown as ConnectedMcpServer;
    connections.set(server.name, server);

    try {
      const [tool] = await fetchToolsForServer(server, controller.signal);
      expect(tool).toBeDefined();
      await tool!.execute({}, { signal: controller.signal });

      expect(request.mock.calls[0]?.[2]).toMatchObject({ signal: controller.signal });
      expect(callTool.mock.calls[0]?.[2]).toMatchObject({ signal: controller.signal });
    } finally {
      connections.delete(server.name);
    }
  });
});
