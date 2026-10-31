import { describe, expect, it } from 'vitest';
import {
  TAG_COLORS,
  addSessionTag,
  clearSessionTags,
  describeTagStore,
  emptyTagStore,
  firstFreeColor,
  formatTagList,
  labelOf,
  normalizeTagStore,
  removeSessionTag,
  renameTagLabel,
  resolveTagColor,
  resolveTagTokens,
  setSessionTags,
  tagCounts,
  tagsOf,
} from './tags.js';

describe('normalizeTagStore', () => {
  it('缺字段与垃圾输入都收敛成一份可用的空表', () => {
    for (const raw of [undefined, null, 42, 'nope', [], {}]) {
      const store = normalizeTagStore(raw);
      expect(store.options.map((option) => option.id).sort()).toEqual([...TAG_COLORS].sort());
      expect(store.assignments).toEqual({});
    }
  });

  it('丢掉未知色槽、重复项，并按色序重排', () => {
    const store = normalizeTagStore({
      version: 1,
      options: [
        { id: 'red', label: '  紧急  ', color: '#FF3B30' },
        { id: 'nope', label: 'x', color: '#123456' },
      ],
      assignments: {
        s1: ['gray', 'red', 'red', 'chartreuse'],
        s2: [],
        '  ': ['red'],
        s3: 'red',
      },
    });
    expect(labelOf(store, 'red')).toBe('紧急');
    expect(labelOf(store, 'green')).toBe('Green');
    // 7 个色槽是产品契约：文件里没写到的颜色也要补回来，否则那个颜色再也打不上。
    expect(store.options).toHaveLength(TAG_COLORS.length);
    expect(store.assignments).toEqual({ s1: ['red', 'gray'] });
  });

  it('空名字不覆盖默认名，过长名字被截断', () => {
    expect(labelOf(normalizeTagStore({ options: [{ id: 'red', label: '   ' }] }), 'red')).toBe('Red');
    const long = labelOf(normalizeTagStore({ options: [{ id: 'blue', label: 'x'.repeat(60) }] }), 'blue');
    expect(long.length).toBe(24);
  });

  it('修复丢失或被修改的颜色值，保持固定七色槽', () => {
    const store = normalizeTagStore({ options: [{ id: 'red', label: '重要', color: '#123456' }] });
    expect(store.options[0]).toMatchObject({ id: 'red', label: '重要', color: '#FF3B30' });
  });
});

describe('色槽解析', () => {
  it('未知的长命令按输入长度读取，不枚举整个后缀', () => {
    let reads = 0;
    const raw = Array.from({ length: 100 }, () => 'unknown');
    const tokens = new Proxy(raw, {
      get(target, key, receiver) {
        if (typeof key === 'string' && /^\d+$/.test(key)) reads += 1;
        return Reflect.get(target, key, receiver);
      },
    });
    expect(resolveTagTokens(emptyTagStore(), tokens).unknown).toEqual(raw);
    expect(reads).toBeLessThan(raw.length * 10);
  });

  it('包含空格的自定义名字可以与其它色槽一起解析', () => {
    const store = renameTagLabel(emptyTagStore(), 'red', 'Needs Review');
    expect(resolveTagTokens(store, ['Needs', 'Review', 'blue', 'unknown'])).toEqual({
      colors: ['red', 'blue'],
      unknown: ['unknown'],
    });
  });
  it('接受色槽 id、默认名与改过的名字', () => {
    const store = renameTagLabel(emptyTagStore(), 'red', '阻塞');
    expect(resolveTagColor(store, 'red')).toBe('red');
    expect(resolveTagColor(store, '  RED ')).toBe('red');
    expect(resolveTagColor(store, '阻塞')).toBe('red');
    // 改名之后默认名仍要命中，否则顺手记下的旧命令就废了。
    expect(resolveTagColor(store, 'Red')).toBe('red');
    expect(resolveTagColor(store, 'unknown')).toBeNull();
  });
});

describe('会话归属', () => {
  it('打标去重、按色序排；去标到空就删键', () => {
    let store = emptyTagStore();
    store = addSessionTag(store, 's1', 'blue');
    store = addSessionTag(store, 's1', 'red');
    store = addSessionTag(store, 's1', 'blue');
    expect(tagsOf(store, 's1')).toEqual(['red', 'blue']);

    store = removeSessionTag(store, 's1', 'red');
    expect(tagsOf(store, 's1')).toEqual(['blue']);
    store = removeSessionTag(store, 's1', 'blue');
    expect(store.assignments).toEqual({});
  });

  it('重复打标 / 去掉不存在的标签返回同一个对象（调用方据此判断有没有变）', () => {
    const store = addSessionTag(emptyTagStore(), 's1', 'red');
    expect(addSessionTag(store, 's1', 'red')).toBe(store);
    expect(removeSessionTag(store, 's1', 'green')).toBe(store);
    expect(clearSessionTags(store, 'nope')).toBe(store);
  });

  it('不修改传入的 store', () => {
    const store = emptyTagStore();
    const next = setSessionTags(store, 's1', ['red']);
    expect(store.assignments).toEqual({});
    expect(next.assignments).toEqual({ s1: ['red'] });
  });

  it('清空后不再有该会话的键', () => {
    const store = addSessionTag(emptyTagStore(), 's1', 'red');
    expect(clearSessionTags(store, 's1').assignments).toEqual({});
  });
});

describe('用量与展示', () => {
  it('统计每个色槽挂了多少会话，并给出第一个空闲色槽', () => {
    let store = emptyTagStore();
    store = addSessionTag(store, 's1', 'red');
    store = addSessionTag(store, 's2', 'red');
    store = addSessionTag(store, 's2', 'blue');
    const counts = tagCounts(store);
    expect(counts.red).toBe(2);
    expect(counts.blue).toBe(1);
    expect(counts.gray).toBe(0);
    expect(firstFreeColor(store)).toBe('orange');
  });

  it('7 个色槽都用上时没有空闲色槽', () => {
    let store = emptyTagStore();
    TAG_COLORS.forEach((color, index) => {
      store = addSessionTag(store, `s${index}`, color);
    });
    expect(firstFreeColor(store)).toBeNull();
  });

  it('改过名字的色槽在文本里带上 id，没改过只显示名字', () => {
    const store = renameTagLabel(emptyTagStore(), 'red', '阻塞');
    const withTags = addSessionTag(store, 's1', 'red');
    expect(formatTagList(withTags, ['red'])).toBe('阻塞 (red)');
    expect(formatTagList(emptyTagStore(), [])).toBe('（无标签）');
  });

  it('describeTagStore 列出全部色槽与当前会话', () => {
    const store = addSessionTag(emptyTagStore(), 's1', 'red');
    const lines = describeTagStore(store, 's1');
    expect(lines[0]).toContain('7 个固定色槽');
    expect(lines).toHaveLength(TAG_COLORS.length + 2);
    expect(lines.at(-1)).toContain('Red');
    expect(describeTagStore(store, 's2').at(-1)).toContain('无标签');
  });
});
