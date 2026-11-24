import { describe, expect, it } from 'vitest';
import { readPluginUriApis, uriApiVisibleToRole } from './PluginUriApis.js';

const entry = (extra: Record<string, unknown> = {}) => ({
  name: 'notebook',
  description: '笔记本的机读接口文档',
  uri: '/plugin/notebook/api',
  ...extra,
});

describe('readPluginUriApis', () => {
  it('没有声明时是空数组', () => {
    const result = readPluginUriApis(undefined);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toEqual([]);
  });

  it('读名字、说明、URI 与角色', () => {
    const result = readPluginUriApis([entry({ roles: ['需求开发', ' 需求开发 '] })]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual([
      {
        name: 'notebook',
        description: '笔记本的机读接口文档',
        uri: '/plugin/notebook/api',
        roles: ['需求开发'],
      },
    ]);
  });

  it('接受 http(s)、file 与同源根路径三种写法', () => {
    const uris = [
      'https://mica.qirong77.com/plugin/notebook/api',
      'http://127.0.0.1:8787/plugin/notebook/api',
      'file:///Users/me/docs/notebook.md',
      '/plugin/notebook/api',
    ];
    for (const uri of uris) {
      const result = readPluginUriApis([entry({ uri })]);
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.value[0]?.uri).toBe(uri);
    }
  });

  it('拒绝插不进输入框的协议：选中后模型读不到的地址没有意义', () => {
    for (const uri of ['javascript:alert(1)', 'ftp://example.com/doc', 'notebook', '//host/path']) {
      const result = readPluginUriApis([entry({ uri })]);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain('uri');
    }
  });

  it('缺 uri 直接拒绝：选中会插一段空文本', () => {
    const result = readPluginUriApis([entry({ uri: '   ' })]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('uri 不能为空');
  });

  it('名字里有空白直接拒绝：`/` 后面的查询按空白截断', () => {
    const result = readPluginUriApis([entry({ name: 'note book' })]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('不能有空白');
  });

  it('同名条目只留一条：列表里两条同名文档分不清点哪条', () => {
    const result = readPluginUriApis([entry(), entry({ uri: '/plugin/notebook/api/guide' })]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('同名');
  });

  it('roles 不是数组或混进空角色名时整份拒绝', () => {
    for (const roles of ['需求开发', [''], ['需求开发', 1]]) {
      const result = readPluginUriApis([entry({ roles })]);
      expect(result.ok).toBe(false);
    }
  });
});

describe('uriApiVisibleToRole', () => {
  it('没声明角色时对所有会话可见', () => {
    expect(uriApiVisibleToRole({ name: 'a', description: '', uri: '/a', roles: [] }, '')).toBe(true);
  });

  it('声明了角色就只在那个角色下出现', () => {
    const scoped = { name: 'a', description: '', uri: '/a', roles: ['需求开发'] };
    expect(uriApiVisibleToRole(scoped, '需求开发')).toBe(true);
    expect(uriApiVisibleToRole(scoped, '代码评审')).toBe(false);
    // 还没选角色的新会话看不到限定角色的文档
    expect(uriApiVisibleToRole(scoped, '')).toBe(false);
  });
});
