import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { MicaTool, micaTools } from '@packages/mica-tools/index.js';
import { PiModelClient } from './PiModelClient.js';

describe('pi incremental tool arguments', () => {
  it('assembles a large chunked tool input once and returns its result on the next request', async () => {
    const content = '中文-x\\n'.repeat(64 * 1024);
    const input = JSON.stringify({ content });
    let executions = 0;
    const tool = new class extends MicaTool {
      constructor() { super('pi_large_arguments', 'Verify the received content', { type: 'object', properties: { content: { type: 'string' } }, required: ['content'] }, { readOnly: true }); }
      async execute(args: { content: string }) { executions++; expect(args.content).toBe(content); return 'large input verified'; }
      onToolUseDisplayText() { return this.name; }
    }();
    let requests = 0;
    let toolResult = '';
    const server = createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => {
        const request = JSON.parse(body);
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        const emit = (delta: unknown, finish_reason: string | null = null) => res.write(`data: ${JSON.stringify({ id: 'large', model: 'test', choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
        if (++requests === 1) {
          emit({ tool_calls: [{ index: 0, id: 'large_call', type: 'function', function: { name: tool.name, arguments: '' } }] });
          for (let i = 0; i < input.length; i += 1024) emit({ tool_calls: [{ index: 0, function: { arguments: input.slice(i, i + 1024) } }] });
          emit({}, 'tool_calls');
        } else {
          toolResult = request.messages.find((message: { role: string }) => message.role === 'tool')?.content;
          emit({ content: 'done' });
          emit({}, 'stop');
        }
        res.end('data: [DONE]\n\n');
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    micaTools.registerRuntime(tool);
    try {
      const baseURL = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
      const client = new PiModelClient({ model: 'test', baseURL, apiKey: 'test', systemPrompt: 'test',
        provider: { id: 'local', api_base: baseURL, protocol: 'openai_chat_completions', supportsEffort: false },
        toolFilter: (name) => name === tool.name,
      });
      expect(await client.query('verify the large input', { maxTurns: 2, signal: AbortSignal.timeout(10_000) })).toBe('done');
      expect(executions).toBe(1);
      expect(requests).toBe(2);
      expect(toolResult).toBe('large input verified');
    } finally {
      micaTools.unregisterRuntime(tool);
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
