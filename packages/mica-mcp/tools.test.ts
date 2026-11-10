import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CallToolResult, ContentBlock } from '@modelcontextprotocol/sdk/types.js';
import type { ConnectedMcpServer } from './client.js';
import { connections } from './client.js';
import * as mcpClient from './client.js';
import { fetchToolsForServer } from './tools.js';

describe('MCP proxy tools', () => {
  afterEach(() => {
    connections.delete('test');
    vi.restoreAllMocks();
  });

  async function createProxyTool(
    result: CallToolResult = { content: [{ type: 'text', text: 'ok' }] },
    signal?: AbortSignal,
  ) {
    const request = vi.fn(async (..._args: unknown[]) => ({
      tools: [{ name: 'lookup', description: 'Lookup', inputSchema: { type: 'object' } }],
    }));
    const callTool = vi.fn(async (..._args: unknown[]) => result);
    const cleanup = vi.fn(async () => undefined);
    const server = {
      name: 'test',
      config: { command: 'test' },
      cleanup,
      client: { request, callTool },
    } as unknown as ConnectedMcpServer;
    connections.set(server.name, server);

    const [tool] = await fetchToolsForServer(server, signal);
    if (!tool) throw new Error('Expected a proxy tool');
    return { tool, request, callTool, cleanup, server };
  }

  it('forwards the agent abort signal to tools/list and tools/call', async () => {
    const controller = new AbortController();
    const { tool, request, callTool } = await createProxyTool(undefined, controller.signal);
    await tool.execute({}, { signal: controller.signal });

    expect(request.mock.calls[0]?.[2]).toMatchObject({ signal: controller.signal });
    expect(callTool.mock.calls[0]?.[2]).toMatchObject({ signal: controller.signal });
    expect(callTool.mock.calls[0]?.[0]).toEqual({ name: 'lookup', arguments: {} });
  });

  it('keeps text-only results as newline-joined strings', async () => {
    const { tool } = await createProxyTool({
      content: [
        { type: 'text', text: 'first' },
        { type: 'text', text: 'second' },
      ],
    });
    expect(await tool.execute({})).toBe('first\nsecond');
  });

  it('keeps the original text-only output limit and truncation notice', async () => {
    const { tool } = await createProxyTool({
      content: [{ type: 'text', text: `head${'a'.repeat(70_000)}tail` }],
    });
    const result = await tool.execute({});
    expect(typeof result).toBe('string');
    expect(result.length).toBeLessThanOrEqual(60_000);
    expect(result).toContain('MCP test.lookup 输出过大');
    expect(result).toContain('head');
    expect(result).toContain('tail');
  });

  it('preserves empty-content and empty-text results', async () => {
    const { tool, callTool } = await createProxyTool({ content: [] });
    expect(await tool.execute({})).toBe('[]');
    callTool.mockResolvedValueOnce({ content: [{ type: 'text', text: '' }] });
    expect(await tool.execute({})).toBe('(no output)');
  });

  it('keeps mixed text and multiple images in their original order', async () => {
    const { tool } = await createProxyTool({
      content: [
        { type: 'text', text: 'before' },
        { type: 'image', mimeType: 'image/png', data: 'cG5n' },
        { type: 'text', text: 'between' },
        { type: 'image', mimeType: 'image/jpeg', data: 'anBlZw==' },
        { type: 'text', text: 'after' },
      ],
    });
    expect(await tool.execute({})).toEqual([
      { type: 'text', text: 'before' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'cG5n' } },
      { type: 'text', text: 'between' },
      { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'anBlZw==' } },
      { type: 'text', text: 'after' },
    ]);
  });

  it.each(['image/jpeg', 'image/png', 'image/gif', 'image/webp'])(
    'maps image-only %s results to standard tool image blocks',
    async (mimeType) => {
      const { tool } = await createProxyTool({
        content: [{ type: 'image', mimeType, data: 'aW1hZ2U=' }],
      });
      expect(await tool.execute({})).toEqual([
        { type: 'image', source: { type: 'base64', media_type: mimeType, data: 'aW1hZ2U=' } },
      ]);
    },
  );

  it('does not truncate large images or serialize them through the text budget', async () => {
    const data = 'abcd'.repeat(150_000);
    const { tool, callTool } = await createProxyTool({
      content: [{ type: 'image', mimeType: 'image/png', data }],
    });
    const image = { type: 'image', source: { type: 'base64', media_type: 'image/png', data } };
    expect(await tool.execute({})).toEqual([image]);

    callTool.mockResolvedValueOnce({
      content: [
        { type: 'text', text: 'caption'.repeat(12_000) },
        { type: 'image', mimeType: 'image/png', data },
      ],
    });
    const mixed = await tool.execute({});
    if (typeof mixed === 'string') throw new Error('Expected image blocks');
    expect(mixed[0]).toMatchObject({ type: 'text', text: expect.stringContaining('输出过大') });
    expect(mixed[1]).toEqual(image);
  });

  it('shares the mixed-result text budget across blocks without changing image or empty text blocks', async () => {
    const { tool } = await createProxyTool({
      content: [
        { type: 'text', text: 'a'.repeat(40_000) },
        { type: 'image', mimeType: 'image/png', data: 'cG5n' },
        { type: 'text', text: '' },
        { type: 'text', text: 'b'.repeat(40_000) },
      ],
    });
    const result = await tool.execute({});
    if (typeof result === 'string') throw new Error('Expected image blocks');
    expect(
      result.reduce((total, block) => total + (block.type === 'text' ? block.text.length : 0), 0),
    ).toBeLessThanOrEqual(60_000);
    expect(result[1]).toEqual({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'cG5n' } });
    expect(result[2]).toEqual({ type: 'text', text: '' });
  });

  it('reports unsupported image MIME types without including their base64 data', async () => {
    const data = 'PRIVATE_BASE64_PAYLOAD'.repeat(30_000);
    const { tool } = await createProxyTool({
      content: [{ type: 'image', mimeType: 'image/svg+xml', data }],
    });
    const result = await tool.execute({});
    expect(typeof result).toBe('string');
    expect(result).toContain('unsupported MIME type image/svg+xml');
    expect(result).not.toContain('PRIVATE_BASE64_PAYLOAD');
    expect(result.length).toBeLessThan(500);
  });

  it('summarizes unsupported content without serializing its payload or dropping supported images', async () => {
    const data = 'PRIVATE_BASE64_PAYLOAD'.repeat(30_000);
    const unsupported: ContentBlock[] = [
      { type: 'audio', mimeType: 'audio/wav', data },
      { type: 'resource', resource: { uri: 'file:///data.bin', mimeType: 'application/octet-stream', blob: data } },
    ];
    const { tool, callTool } = await createProxyTool({ content: unsupported });
    const text = await tool.execute({});
    expect(text).toContain('audio content omitted');
    expect(text).toContain('resource content omitted');
    expect(text).not.toContain('PRIVATE_BASE64_PAYLOAD');
    expect(text.length).toBeLessThan(1000);

    callTool.mockResolvedValueOnce({
      content: [
        { type: 'text', text: 'caption' },
        ...unsupported,
        { type: 'image', mimeType: 'image/png', data: 'cG5n' },
      ],
    });
    const mixed = await tool.execute({});
    if (typeof mixed === 'string') throw new Error('Expected image blocks');
    expect(mixed[0]).toEqual({ type: 'text', text: 'caption' });
    expect(mixed[1]).toMatchObject({ type: 'text', text: expect.stringContaining('audio content omitted') });
    expect(mixed[3]).toEqual({
      type: 'image',
      source: { type: 'base64', media_type: 'image/png', data: 'cG5n' },
    });
    expect(JSON.stringify(mixed)).not.toContain('PRIVATE_BASE64_PAYLOAD');
  });

  it('preserves readable resource text and bounded resource links', async () => {
    const { tool } = await createProxyTool({
      content: [
        { type: 'resource', resource: { uri: 'file:///report.txt', text: 'actual report' } },
        { type: 'resource_link', name: 'report', uri: 'file:///report.txt' },
      ],
    });
    expect(await tool.execute({})).toBe('actual report\nreport: file:///report.txt');
  });

  it('still throws joined MCP error text and uses the generic error when there is no text', async () => {
    const { tool, callTool } = await createProxyTool({
      isError: true,
      content: [
        { type: 'text', text: 'failed' },
        { type: 'image', mimeType: 'image/png', data: 'cG5n' },
        { type: 'text', text: 'details' },
      ],
    });
    await expect(tool.execute({})).rejects.toThrow('failed\ndetails');
    callTool.mockResolvedValueOnce({
      isError: true,
      content: [{ type: 'image', mimeType: 'image/png', data: 'cG5n' }],
    });
    await expect(tool.execute({})).rejects.toThrow('MCP tool returned an error');
  });

  it('retries an expired MCP session once and preserves image results and the abort signal', async () => {
    const controller = new AbortController();
    const { tool, callTool, cleanup, server } = await createProxyTool();
    callTool.mockRejectedValueOnce(new Error('Session not found'));
    const retriedCall = vi.fn(async (..._args: unknown[]) => ({
      content: [{ type: 'image', mimeType: 'image/png', data: 'cG5n' }],
    }));
    const reconnected = { ...server, client: { callTool: retriedCall } } as unknown as ConnectedMcpServer;
    const connect = vi.spyOn(mcpClient, 'connectToServer').mockResolvedValueOnce(reconnected);
    expect(await tool.execute({ query: 'test' }, { signal: controller.signal })).toEqual([
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'cG5n' } },
    ]);
    expect(cleanup).toHaveBeenCalledOnce();
    expect(connect).toHaveBeenCalledWith('test', server.config, controller.signal);
    expect(retriedCall.mock.calls[0]?.[0]).toEqual({ name: 'lookup', arguments: { query: 'test' } });
    expect(retriedCall.mock.calls[0]?.[2]).toMatchObject({ signal: controller.signal });
  });

  it('does not reconnect an expired session after the agent aborts', async () => {
    const controller = new AbortController();
    const { tool, callTool, cleanup } = await createProxyTool();
    callTool.mockRejectedValueOnce(new Error('Session not found'));
    const connect = vi.spyOn(mcpClient, 'connectToServer');
    controller.abort();
    await expect(tool.execute({}, { signal: controller.signal })).rejects.toThrow('Session not found');
    expect(connect).not.toHaveBeenCalled();
    expect(cleanup).not.toHaveBeenCalled();
  });
});
