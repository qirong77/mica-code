import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { expandMcpEnv, readMcpConfig } from './config.js';

describe('expandMcpEnv', () => {
  it('用环境变量替换占位符', () => {
    expect(expandMcpEnv('http://127.0.0.1:${PORT}/mcp/browser', { PORT: '8899' })).toBe(
      'http://127.0.0.1:8899/mcp/browser',
    );
  });

  it('变量缺失时使用默认值', () => {
    expect(expandMcpEnv('http://127.0.0.1:${PORT:-8787}/mcp/browser', {})).toBe(
      'http://127.0.0.1:8787/mcp/browser',
    );
  });

  it('变量为空串时也落回默认值', () => {
    expect(expandMcpEnv('${PORT:-8787}', { PORT: '' })).toBe('8787');
  });

  it('既无变量也无默认值时展开为空，不保留占位符', () => {
    expect(expandMcpEnv('a${MISSING}b', {})).toBe('ab');
  });

  it('没有占位符时原样返回', () => {
    expect(expandMcpEnv('http://127.0.0.1:8787/mcp/terminal', { PORT: '1' })).toBe(
      'http://127.0.0.1:8787/mcp/terminal',
    );
  });
});

describe('readMcpConfig', () => {
  let dir: string;
  let path: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'mica-mcp-config-'));
    path = join(dir, 'config.json');
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('展开 http server 的 url 与 headers，stdio 配置原样保留', async () => {
    await writeFile(
      path,
      JSON.stringify({
        mcpServers: {
          'mica-browser': {
            type: 'http',
            url: 'http://127.0.0.1:${PORT:-8787}/mcp/browser',
            headers: { 'x-mica-owner': '${OWNER:-}' },
          },
          stdio: { command: 'npx', args: ['-y', '${NOT_EXPANDED}'] },
        },
      }),
      'utf-8',
    );

    const servers = await readMcpConfig(path, { PORT: '9123', OWNER: 'sess-1' });
    expect(servers['mica-browser']).toEqual({
      type: 'http',
      url: 'http://127.0.0.1:9123/mcp/browser',
      headers: { 'x-mica-owner': 'sess-1' },
    });
    expect(servers.stdio).toEqual({ command: 'npx', args: ['-y', '${NOT_EXPANDED}'] });
  });

  it('缺少 mcpServers 时返回空对象', async () => {
    await writeFile(path, JSON.stringify({ providers: [] }), 'utf-8');
    expect(await readMcpConfig(path)).toEqual({});
  });
});
