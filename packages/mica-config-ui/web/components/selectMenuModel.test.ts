import { describe, expect, it } from 'vitest';
import { buildSelectMenuRows, filterSelectOptions, nextSelectMenuIndex, selectMenuStartIndex } from './selectMenuModel';

const branches = [
  { value: '', label: '全部分支' },
  { value: 'refs/heads/main', label: 'main', group: '本地分支' },
  { value: 'origin/feat/ai/yinpanzhao/multi-turn', label: 'origin/feat/ai/yinpanzhao/multi-turn', group: '远端分支' },
  { value: 'origin/feat/ai/yinpanzhao/multi-agent', label: 'origin/feat/ai/yinpanzhao/multi-agent', group: '远端分支' },
  { value: 'origin/release/1.2', label: 'origin/release/1.2', group: '远端分支' },
];

describe('filterSelectOptions', () => {
  it('空查询保留全部选项且不重排', () => {
    expect(filterSelectOptions(branches, '   ').map((item) => item.value)).toEqual(branches.map((item) => item.value));
  });

  it('按忽略大小写的子串匹配标签与值', () => {
    expect(filterSelectOptions(branches, 'YINPANZHAO').map((item) => item.label)).toEqual([
      'origin/feat/ai/yinpanzhao/multi-turn',
      'origin/feat/ai/yinpanzhao/multi-agent',
    ]);
  });

  it('多个词要求全部命中，因此可以按路径的任意两段收窄', () => {
    expect(filterSelectOptions(branches, 'yinpanzhao agent').map((item) => item.value)).toEqual([
      'origin/feat/ai/yinpanzhao/multi-agent',
    ]);
    expect(filterSelectOptions(branches, 'release 1.2').map((item) => item.value)).toEqual(['origin/release/1.2']);
  });

  it('没有匹配项时返回空列表', () => {
    expect(filterSelectOptions(branches, '不存在的分支')).toEqual([]);
  });
});

describe('buildSelectMenuRows', () => {
  it('分组标题只在组内第一项前出现一次', () => {
    const rows = buildSelectMenuRows(filterSelectOptions(branches, ''));
    expect(rows.map((row) => (row.kind === 'group' ? `#${row.label}` : row.option.value))).toEqual([
      '',
      '#本地分支',
      'refs/heads/main',
      '#远端分支',
      'origin/feat/ai/yinpanzhao/multi-turn',
      'origin/feat/ai/yinpanzhao/multi-agent',
      'origin/release/1.2',
    ]);
  });

  it('下标指向过滤后的位置，键盘高亮与渲染使用的是同一份顺序', () => {
    const rows = buildSelectMenuRows(filterSelectOptions(branches, 'agent'));
    const options = rows.filter((row) => row.kind === 'option');
    expect(options.map((row) => (row.kind === 'option' ? row.index : -1))).toEqual([0]);
  });
});

describe('selectMenuStartIndex / nextSelectMenuIndex', () => {
  it('从当前选中项开始，选中项被禁用时落到第一个可选项', () => {
    const options = [{ value: 'a', disabled: true }, { value: 'b' }];
    expect(selectMenuStartIndex(options, 'a')).toBe(1);
    expect(selectMenuStartIndex(options, 'missing')).toBe(1);
  });

  it('跳过禁用项并循环', () => {
    const options = [{ value: 'a' }, { value: 'b', disabled: true }, { value: 'c' }];
    expect(nextSelectMenuIndex(options, 0, 1)).toBe(2);
    expect(nextSelectMenuIndex(options, 2, 1)).toBe(0);
    expect(nextSelectMenuIndex(options, 0, -1)).toBe(2);
  });

  it('全部禁用或没有选项时返回 -1', () => {
    expect(nextSelectMenuIndex([], 0, 1)).toBe(-1);
    expect(nextSelectMenuIndex([{ value: 'a', disabled: true }], -1, 1)).toBe(-1);
  });

  it('还没高亮时方向决定起点', () => {
    const options = [{ value: 'a' }, { value: 'b' }];
    expect(nextSelectMenuIndex(options, -1, 1)).toBe(0);
    expect(nextSelectMenuIndex(options, -1, -1)).toBe(1);
  });
});
