import { describe, expect, it } from 'vitest';
import {
  addMcpServerEntry,
  changeMcpServerType,
  draftTypeOf,
  mcpIssueMap,
  parseMcpServersDraft,
  readMcpServerFields,
  removeMcpServerEntry,
  serializeMcpServersDraft,
  validateMcpServersDraft,
  writeMcpServerFields,
  type McpServerEntry,
} from './mcpDraft.js';

const stdioEntry = (name: string, raw: Record<string, unknown>): McpServerEntry => ({ name, type: 'stdio', raw });
const httpEntry = (name: string, raw: Record<string, unknown>): McpServerEntry => ({ name, type: 'http', raw });

describe('MCP server 列表模型', () => {
  it('把整份 mcpServers 读成卡片列表，连接方式按有没有 url 判定', () => {
    const result = parseMcpServersDraft(
      JSON.stringify({
        'sequential-thinking': { command: 'npx', args: ['-y', 'pkg'] },
        browser: { url: 'http://127.0.0.1:8787/mcp/browser', type: 'http' },
      }),
    );
    expect(result.error).toBeNull();
    expect(result.entries).toEqual([
      { name: 'sequential-thinking', type: 'stdio', raw: { command: 'npx', args: ['-y', 'pkg'] } },
      { name: 'browser', type: 'http', raw: { url: 'http://127.0.0.1:8787/mcp/browser', type: 'http' } },
    ]);
  });

  it('接受 { "mcpServers": { … } } 外壳，但不是唯一键时不当外壳', () => {
    expect(parseMcpServersDraft('{"mcpServers":{"a":{"command":"npx"}}}').entries).toEqual([
      stdioEntry('a', { command: 'npx' }),
    ]);
    expect(parseMcpServersDraft('{"mcpServers":{"command":"npx"},"other":{}}').entries).toEqual([
      stdioEntry('mcpServers', { command: 'npx' }),
      stdioEntry('other', {}),
    ]);
  });

  it('解析：空文本是空列表；坏 JSON、非对象、条目不是对象都给出错误', () => {
    expect(parseMcpServersDraft('')).toEqual({ entries: [], error: null });
    expect(parseMcpServersDraft('[{"command":"npx"}]').entries).toBeNull();
    expect(parseMcpServersDraft('{').error).toBeTruthy();
    expect(parseMcpServersDraft('{"a":"npx"}').error).toContain('a');
  });

  it('序列化：按固定键序，未知键跟在后头，名称去空白', () => {
    const text = serializeMcpServersDraft([
      stdioEntry(' a ', { stderr: 'pipe', args: ['-y'], command: 'npx', extra: 1 }),
      httpEntry('b', { headers: { Authorization: 'Bearer x' }, url: 'http://x' }),
    ]);
    expect(JSON.parse(text)).toEqual({
      a: { command: 'npx', args: ['-y'], stderr: 'pipe', extra: 1 },
      b: { url: 'http://x', headers: { Authorization: 'Bearer x' } },
    });
    expect(text.endsWith('\n')).toBe(true);
  });

  it('序列化跳过还没填名称的卡片（写盘前校验会先拦住）', () => {
    expect(JSON.parse(serializeMcpServersDraft([stdioEntry('  ', { command: 'npx' })]))).toEqual({});
  });

  it('表单写回保留不认识的键，只覆盖认识的字段', () => {
    const entry = stdioEntry('a', { command: 'npx', args: ['-y', 'pkg'], futureField: { keep: true } });
    const next = writeMcpServerFields(entry, { ...readMcpServerFields(entry.raw, entry.type), command: 'uvx' });
    expect(next).toEqual(stdioEntry('a', { command: 'uvx', args: ['-y', 'pkg'], futureField: { keep: true } }));
  });

  it('可选字段留空就删键，不写空字符串', () => {
    const entry = stdioEntry('a', { command: 'npx', args: ['-y', 'pkg'], cwd: '/tmp', env: { A: '1' } });
    const next = writeMcpServerFields(entry, {
      ...readMcpServerFields(entry.raw, entry.type),
      args: [],
      cwd: '  ',
      env: [],
    });
    expect(next.raw).toEqual({ command: 'npx' });
  });

  it('切到 HTTP：另一侧的已知键删掉，未知键留着，stdio 的 type 不写进文件', () => {
    const entry = stdioEntry('a', { command: 'npx', args: ['-y'], env: { A: '1' }, futureField: 1 });
    const http = changeMcpServerType(entry, 'http');
    expect(http).toEqual(httpEntry('a', { futureField: 1 }));
    const filled = writeMcpServerFields(http, {
      ...readMcpServerFields(http.raw, 'http'),
      url: 'http://127.0.0.1:8787/mcp/browser',
      headers: [{ key: 'x-mica-owner', value: 'session-1' }],
    });
    expect(JSON.parse(serializeMcpServersDraft([filled]))).toEqual({
      a: { url: 'http://127.0.0.1:8787/mcp/browser', headers: { 'x-mica-owner': 'session-1' }, futureField: 1 },
    });
    // 切回本地进程：HTTP 那一侧没了，只剩未知键，命令重新填。
    expect(changeMcpServerType(filled, 'stdio').raw).toEqual({ futureField: 1 });
  });

  it('README 里的 type: http 会被原样保留', () => {
    const entry = httpEntry('b', { type: 'http', url: 'http://x' });
    expect(JSON.parse(serializeMcpServersDraft([entry]))).toEqual({ b: { type: 'http', url: 'http://x' } });
  });

  it('校验按字段定位：名称、命令、地址与重名', () => {
    const issues = validateMcpServersDraft([
      stdioEntry('', {}),
      stdioEntry('bad name', { command: 'npx' }),
      httpEntry('dup', { url: '  ' }),
      httpEntry('dup', { url: 'http://x' }),
    ]);
    const map = mcpIssueMap(issues);
    expect(map.get('servers.0.name')).toBeTruthy();
    expect(map.get('servers.0.command')).toBeTruthy();
    expect(map.get('servers.1.name')).toContain('名称');
    expect(map.get('servers.2.url')).toBeTruthy();
    expect(map.get('servers.3.name')).toContain('重名');
    expect(validateMcpServersDraft([stdioEntry('a', { command: 'npx' }), httpEntry('b', { url: 'http://x' })])).toEqual(
      [],
    );
  });

  it('新增卡片用不重名的默认名字，删除按下标', () => {
    const one = addMcpServerEntry([]);
    expect(one).toEqual([{ name: 'server', type: 'stdio', raw: {} }]);
    expect(addMcpServerEntry(one).at(-1)?.name).toBe('server-2');
    expect(removeMcpServerEntry([stdioEntry('a', {}), stdioEntry('b', {})], 0).map((entry) => entry.name)).toEqual([
      'b',
    ]);
  });

  it('draftTypeOf 与表单字段互认', () => {
    expect(draftTypeOf({ url: 'http://x' })).toBe('http');
    expect(draftTypeOf({ type: 'http', url: 'http://x' })).toBe('http');
    expect(draftTypeOf({ command: 'npx' })).toBe('stdio');
    expect(
      readMcpServerFields({ command: 'npx', args: ['-y'], env: { DEBUG: '1' }, cwd: '/tmp' }, 'stdio'),
    ).toMatchObject({
      type: 'stdio',
      command: 'npx',
      args: ['-y'],
      env: [{ key: 'DEBUG', value: '1' }],
      cwd: '/tmp',
    });
  });
});
