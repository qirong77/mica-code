import { describe, expect, it } from 'vitest';
import { completionVisibleToRole, readPluginCompletions } from './PluginCompletions.js';

const entry = (extra: Record<string, unknown> = {}) => ({
  name: 'role',
  description: '记一条经验',
  insert: '用 demand_role 把这条经验写回角色文件：',
  ...extra,
});

describe('readPluginCompletions', () => {
  it('没有声明时是空数组', () => {
    const result = readPluginCompletions(undefined);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toEqual([]);
  });

  it('读名字、说明、插入正文与角色', () => {
    const result = readPluginCompletions([entry({ roles: ['需求开发', ' 需求开发 '] })]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual([
      {
        name: 'role',
        description: '记一条经验',
        insert: '用 demand_role 把这条经验写回角色文件：',
        roles: ['需求开发'],
      },
    ]);
  });

  it('缺 insert 直接拒绝：选中会插一段空文本，比没这条更糟', () => {
    const result = readPluginCompletions([entry({ insert: '   ' })]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('insert 不能为空');
  });

  it('名字里有空白直接拒绝：`/` 后面的查询按空白截断', () => {
    const result = readPluginCompletions([entry({ name: '记 经验' })]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('不能有空白');
  });

  it('重名与坏结构都在解析阶段拦下', () => {
    const duplicated = readPluginCompletions([entry(), entry()]);
    expect(duplicated.ok).toBe(false);
    if (!duplicated.ok) expect(duplicated.error).toContain('两个同名的 role');

    const notArray = readPluginCompletions({ name: 'role' });
    expect(notArray.ok).toBe(false);
    if (!notArray.ok) expect(notArray.error).toContain('必须是数组');

    const brokenRoles = readPluginCompletions([entry({ roles: 'any' })]);
    expect(brokenRoles.ok).toBe(false);
    if (!brokenRoles.ok) expect(brokenRoles.error).toContain('roles 必须是数组');
  });
});

describe('completionVisibleToRole', () => {
  const completion = { name: 'role', description: '', insert: 'x', roles: [] };

  it('没声明角色时所有角色可见', () => {
    expect(completionVisibleToRole(completion, '')).toBe(true);
    expect(completionVisibleToRole(completion, '需求开发')).toBe(true);
  });

  it('声明了角色就只在那个角色下可见', () => {
    const scoped = { ...completion, roles: ['需求开发'] };
    expect(completionVisibleToRole(scoped, '需求开发')).toBe(true);
    expect(completionVisibleToRole(scoped, 'default')).toBe(false);
    // 还没选角色（空串）时不放行：列出来点一下也只会插一段这个角色才看得懂的提示
    expect(completionVisibleToRole(scoped, '')).toBe(false);
  });
});
