import { describe, expect, it } from 'vitest';
import { buildMcpCatalog } from './catalog.js';

describe('mcp catalog', () => {
  it('merges user config, session config and connected servers', () => {
    const catalog = buildMcpCatalog({
      configured: { 'sequential-thinking': { command: 'npx', args: ['-y', 'server'] } },
      // 桌面端按会话生成的内置 server：不在 config.json 里
      extra: {
        'mica-browser': { type: 'http', url: 'http://127.0.0.1:8787/mcp/browser' },
        'mica-terminal': { type: 'http', url: 'http://127.0.0.1:8787/mcp/terminal' },
      },
      statuses: new Map([
        ['mica-browser', { status: 'connected', toolCount: 1 }],
        ['stale', { status: 'failed', toolCount: 0 }],
      ]),
    });

    expect(catalog).toEqual([
      { name: 'mica-browser', status: 'connected', toolCount: 1 },
      { name: 'mica-terminal', status: 'configured', toolCount: 0 },
      { name: 'sequential-thinking', status: 'configured', toolCount: 0 },
      { name: 'stale', status: 'failed', toolCount: 0 },
    ]);
  });

  it('returns an empty list when nothing is configured', () => {
    expect(buildMcpCatalog()).toEqual([]);
    expect(buildMcpCatalog({ configured: {}, extra: {} })).toEqual([]);
  });

  it('lists a built-in server before the connection finished', () => {
    // 还没连（会话刚起来）也要能列出来：界面据此显示开关
    expect(
      buildMcpCatalog({ extra: { 'mica-browser': { type: 'http', url: 'http://127.0.0.1:1/mcp/browser' } } }),
    ).toEqual([{ name: 'mica-browser', status: 'configured', toolCount: 0 }]);
  });
});
