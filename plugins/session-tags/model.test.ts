import { describe, expect, it } from 'vitest';
import {
  MAX_TAGS,
  addSessionTag,
  addTag,
  cleanTagLabel,
  clearSessionTags,
  describeTagStore,
  emptyTagStore,
  findTag,
  formatTagList,
  normalizeTagStore,
  recolorTag,
  removeSessionTag,
  removeTag,
  renameTag,
  resolveTagTokens,
  seedTagStore,
  setSessionTags,
  tagCounts,
  tagsOf,
} from './model.js';
import { resolveStore } from './store.js';

describe('normalizeTagStore', () => {
  it('缺字段与垃圾输入都收敛成一份空的标签表', () => {
    for (const raw of [undefined, null, 42, 'nope', [], {}]) {
      const store = normalizeTagStore(raw);
      expect(store.options).toEqual([]);
      expect(store.assignments).toEqual({});
    }
  });

  it('丢掉没有名字、重复 id 的项，非法颜色退成默认色', () => {
    const store = normalizeTagStore({
      options: [
        { id: 'tag-1', label: '  待办  ', color: '#FF3B30' },
        { id: 'tag-1', label: '重复', color: '#007AFF' },
        { id: 'tag-2', label: '   ', color: '#007AFF' },
        { id: 'tag-3', label: '看板', color: 'not-a-color' },
      ],
      assignments: {},
    });
    expect(store.options).toEqual([
      { id: 'tag-1', label: '待办', color: '#FF3B30' },
      { id: 'tag-3', label: '看板', color: '#FF9500' },
    ]);
  });

  it('归属按标签表顺序排、丢掉指向已删标签的 id', () => {
    const store = normalizeTagStore({
      options: [
        { id: 'tag-1', label: '待办', color: '#FF3B30' },
        { id: 'tag-2', label: '进行中', color: '#007AFF' },
      ],
      assignments: { s1: ['tag-2', 'gone', 'tag-1', 'tag-1'], s2: ['gone'], '  ': ['tag-1'], s3: 'tag-1' },
    });
    expect(store.assignments).toEqual({ s1: ['tag-1', 'tag-2'] });
  });

  it('名字过长会被截断到上限', () => {
    const store = normalizeTagStore({ options: [{ id: 'tag-1', label: 'x'.repeat(60), color: '#FF3B30' }] });
    expect(store.options[0]!.label.length).toBe(24);
  });

  it('旧形态的固定色槽：没改过名、没挂过会话的丢掉，用过的保留', () => {
    const store = normalizeTagStore({
      options: [
        { id: 'red', label: 'Red', color: '#FF3B30' },
        { id: 'orange', label: 'Orange', color: '#FF9500' },
        { id: 'blue', label: 'Blue', color: '#007AFF' },
      ],
      assignments: { s1: ['blue'] },
    });
    // blue 有会话挂着 → 留着；red / orange 是没动过的旧槽位 → 收敛时清掉。
    expect(store.options.map((option) => option.id)).toEqual(['blue']);
    expect(store.assignments).toEqual({ s1: ['blue'] });
  });

  it('改过名字的旧槽位算用户真的用过，不会被清掉', () => {
    const store = normalizeTagStore({ options: [{ id: 'red', label: '阻塞', color: '#FF3B30' }] });
    expect(store.options).toEqual([{ id: 'red', label: '阻塞', color: '#FF3B30' }]);
  });
});

describe('启动时的那一份', () => {
  it('文件不存在时预置一个「待 review」', () => {
    const { store, dirty } = resolveStore(undefined);
    expect(dirty).toBe(true);
    expect(store.options).toHaveLength(1);
    expect(store.options[0]!.label).toBe('待 review');
  });

  it('把标签删空的文件不会再长出默认标签', () => {
    const empty = { version: 1, name: 'Session Tags', options: [], assignments: {} };
    expect(resolveStore(empty)).toMatchObject({ dirty: false, store: { options: [] } });
  });

  it('只剩 v1 那堆没用过的固定色槽时，换成默认的「待 review」', () => {
    const legacy = {
      version: 1,
      name: 'Session Tags',
      options: [
        { id: 'red', label: 'Red', color: '#FF3B30' },
        { id: 'gray', label: 'Gray', color: '#8E8E93' },
      ],
      assignments: {},
    };
    const { store, dirty } = resolveStore(legacy);
    expect(dirty).toBe(true);
    expect(store.options.map((option) => option.label)).toEqual(['待 review']);
  });

  it('文件里有需要收敛的东西时才写回', () => {
    const clean = { version: 1, name: 'Session Tags', options: [{ id: 'tag-1', label: '待办', color: '#FF3B30' }], assignments: { s1: ['tag-1'] } };
    expect(resolveStore(clean).dirty).toBe(false);
    // 归属里留着指向已删标签的死 id：写回收敛版本，宿主那边才不会读到画不出来的项
    const dead = { ...clean, assignments: { s1: ['tag-1', 'gone'] } };
    expect(resolveStore(dead)).toMatchObject({ dirty: true, store: { assignments: { s1: ['tag-1'] } } });
  });
});

describe('标签表的编辑', () => {
  it('新增时分配稳定 id 并做重名 / 空名字 / 数量校验', () => {
    let store = seedTagStore();
    const added = addTag(store, { label: '待办', color: '#FF3B30' });
    expect(added.error).toBeUndefined();
    expect(added.id).toBe('tag-2');
    store = added.store;
    expect(store.options.map((option) => option.label)).toEqual(['待 review', '待办']);

    expect(addTag(store, { label: '   ' }).error).toContain('不能为空');
    expect(addTag(store, { label: '待办' }).error).toContain('已经有');
    // 大小写不同的同名也算重名
    expect(addTag(store, { label: '待 REVIEW' }).error).toContain('已经有');
  });

  it('名字里的空白与换行被压掉，中英文都能当名字', () => {
    expect(cleanTagLabel('  待\n review \t')).toBe('待 review');
    const added = addTag(emptyTagStore(), { label: '  Need  Review ', color: 'not-a-color' });
    expect(added.store.options[0]).toMatchObject({ label: 'Need Review', color: '#FF9500' });
  });

  it('超过上限就拒绝，而不是静默截断', () => {
    let store = emptyTagStore();
    for (let index = 0; index < MAX_TAGS; index += 1) store = addTag(store, { label: `标签${index}` }).store;
    expect(store.options).toHaveLength(MAX_TAGS);
    expect(addTag(store, { label: '多出来的' }).error).toContain(String(MAX_TAGS));
  });

  it('改名与换色不动 id，所以已打的标不会丢', () => {
    let store = addTag(emptyTagStore(), { label: '待办' }).store;
    const id = store.options[0]!.id;
    store = addSessionTag(store, 's1', id);
    store = renameTag(store, id, '进行中').store;
    store = recolorTag(store, id, '#007AFF').store;
    expect(store.options[0]).toEqual({ id, label: '进行中', color: '#007AFF' });
    expect(tagsOf(store, 's1')).toEqual([id]);
  });

  it('改名撞上另一个标签时报错，什么都不改', () => {
    let store = addTag(emptyTagStore(), { label: '待办' }).store;
    store = addTag(store, { label: '进行中' }).store;
    const result = renameTag(store, store.options[0]!.id, '进行中');
    expect(result.error).toContain('已经有');
    expect(result.store).toBe(store);
  });

  it('删标签会同时把它从所有会话上摘掉', () => {
    let store = addTag(emptyTagStore(), { label: '待办' }).store;
    const keep = addTag(store, { label: '进行中' }).store;
    store = keep;
    const [dropId, keepId] = store.options.map((option) => option.id);
    store = addSessionTag(store, 's1', dropId!);
    store = addSessionTag(store, 's1', keepId!);
    store = addSessionTag(store, 's2', dropId!);

    store = removeTag(store, dropId!).store;
    expect(store.options.map((option) => option.id)).toEqual([keepId]);
    expect(store.assignments).toEqual({ s1: [keepId] });
  });

  it('改一个不存在的标签返回错误而不是崩掉', () => {
    expect(renameTag(emptyTagStore(), 'nope', 'x').error).toContain('不存在');
    expect(recolorTag(emptyTagStore(), 'nope', '#FF3B30').error).toContain('不存在');
    expect(removeTag(emptyTagStore(), 'nope').error).toContain('不存在');
  });
});

describe('按名字解析', () => {
  it('大小写不敏感，也能按 id 命中', () => {
    const store = addTag(emptyTagStore(), { label: 'Needs Review' }).store;
    const id = store.options[0]!.id;
    expect(findTag(store, 'needs review')?.id).toBe(id);
    expect(findTag(store, '  NEEDS REVIEW ')?.id).toBe(id);
    expect(findTag(store, id)?.id).toBe(id);
    expect(findTag(store, 'unknown')).toBeNull();
  });

  it('名字含空格时按最长匹配吃词，其余当认不出的词', () => {
    const store = addTag(emptyTagStore(), { label: 'Needs Review' }).store;
    expect(resolveTagTokens(store, ['Needs', 'Review', 'unknown'])).toEqual({
      tags: [store.options[0]],
      unknown: ['unknown'],
    });
  });

  it('未知输入按词前进，不枚举所有后缀', () => {
    let reads = 0;
    const raw = Array.from({ length: 100 }, () => 'unknown');
    const tokens = new Proxy(raw, {
      get(target, key, receiver) {
        if (typeof key === 'string' && /^\d+$/.test(key)) reads += 1;
        return Reflect.get(target, key, receiver);
      },
    });
    expect(resolveTagTokens(seedTagStore(), tokens).unknown).toEqual(raw);
    expect(reads).toBeLessThan(raw.length * 10);
  });
});

describe('会话归属', () => {
  it('打标去重、按标签表顺序排；去标到空就删键', () => {
    let store = addTag(emptyTagStore(), { label: '待办' }).store;
    store = addTag(store, { label: '进行中' }).store;
    const [first, second] = store.options.map((option) => option.id);

    store = addSessionTag(store, 's1', second!);
    store = addSessionTag(store, 's1', first!);
    store = addSessionTag(store, 's1', second!);
    expect(tagsOf(store, 's1')).toEqual([first, second]);

    store = removeSessionTag(store, 's1', first!);
    expect(tagsOf(store, 's1')).toEqual([second]);
    store = removeSessionTag(store, 's1', second!);
    expect(store.assignments).toEqual({});
  });

  it('重复打标 / 去掉不存在的标签返回同一个对象（调用方据此判断有没有变）', () => {
    const base = addTag(emptyTagStore(), { label: '待办' }).store;
    const id = base.options[0]!.id;
    const store = addSessionTag(base, 's1', id);
    expect(addSessionTag(store, 's1', id)).toBe(store);
    expect(removeSessionTag(store, 's1', 'nope')).toBe(store);
    expect(clearSessionTags(store, 'nope')).toBe(store);
  });

  it('不修改传入的 store', () => {
    const base = addTag(emptyTagStore(), { label: '待办' }).store;
    const id = base.options[0]!.id;
    const next = setSessionTags(base, 's1', [id]);
    expect(base.assignments).toEqual({});
    expect(next.assignments).toEqual({ s1: [id] });
  });
});

describe('用量与展示', () => {
  it('统计每个标签挂了多少会话', () => {
    let store = addTag(emptyTagStore(), { label: '待办' }).store;
    store = addTag(store, { label: '进行中' }).store;
    const [first, second] = store.options.map((option) => option.id);
    store = addSessionTag(store, 's1', first!);
    store = addSessionTag(store, 's2', first!);
    store = addSessionTag(store, 's2', second!);
    expect(tagCounts(store)).toEqual({ [first!]: 2, [second!]: 1 });
  });

  it('formatTagList 用名字而不是 id', () => {
    const store = addSessionTag(addTag(emptyTagStore(), { label: '待办' }).store, 's1', 'tag-1');
    expect(formatTagList(store, ['tag-1'])).toBe('待办');
    expect(formatTagList(store, [])).toBe('（无标签）');
  });

  it('describeTagStore：有标签列全表，没标签时指路到打开标签页面的入口', () => {
    const store = addSessionTag(addTag(emptyTagStore(), { label: '待办' }).store, 's1', 'tag-1');
    const lines = describeTagStore(store, 's1');
    expect(lines[0]).toContain('1 个');
    expect(lines[1]).toContain('待办');
    expect(lines.at(-1)).toContain('待办');
    expect(describeTagStore(store, 's2').at(-1)).toContain('无标签');
    expect(describeTagStore(emptyTagStore()).join('\n')).toContain('打开标签');
  });
});
