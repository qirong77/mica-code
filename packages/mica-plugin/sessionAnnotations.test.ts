import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  annotationsOf,
  normalizeSessionAnnotations,
  pluginDataDir,
  readAllSessionAnnotations,
  readSessionAnnotations,
  resolveAnnotationOptions,
  sessionAnnotationsPath,
  setSessionAnnotations,
  toggleSessionAnnotation,
  writeSessionAnnotations,
} from './sessionAnnotations.js';

describe('normalizeSessionAnnotations', () => {
  it('垃圾输入一律收敛成空表，不抛错', () => {
    for (const raw of [undefined, null, 42, 'x', [], { options: 'nope' }]) {
      const data = normalizeSessionAnnotations(raw);
      expect(data.options).toEqual([]);
      expect(data.assignments).toEqual({});
    }
  });

  it('丢掉重复 option、非法颜色退灰、空名字留空', () => {
    const data = normalizeSessionAnnotations({
      options: [
        { id: 'a', label: '第一个', color: '#ff0000' },
        { id: 'a', label: '重复', color: '#00ff00' },
        { id: 'b', label: '  ', color: 'red' },
        { label: '没有 id', color: '#0000ff' },
      ],
    });
    expect(data.options.map((option) => option.id)).toEqual(['a', 'b']);
    expect(data.options[0].color).toBe('#ff0000');
    expect(data.options[1].color).toBe('#8E8E93');
    // 空名字不代填 id：读的一侧才知道该退化成什么。
    expect(data.options[1].label).toBe('');
  });

  it('归属保留未知 id（options 可能只是暂时缺），去重并压掉空值', () => {
    const data = normalizeSessionAnnotations({
      options: [{ id: 'a', color: '#ff0000' }],
      assignments: { s1: ['a', 'a', 'gone', ''], s2: [], '  ': ['a'], s3: 'a' },
    });
    expect(data.assignments).toEqual({ s1: ['a', 'gone'] });
  });
});

describe('归属操作', () => {
  const base = normalizeSessionAnnotations({
    options: [
      { id: 'red', label: '红', color: '#FF3B30' },
      { id: 'blue', label: '蓝', color: '#007AFF' },
    ],
  });

  it('按 options 的定义顺序排，而不是添加顺序', () => {
    const data = setSessionAnnotations(base, 's1', ['blue', 'red']);
    expect(annotationsOf(data, 's1')).toEqual(['red', 'blue']);
  });

  it('未知 id 与非数组输入被忽略；清空后删键', () => {
    expect(annotationsOf(setSessionAnnotations(base, 's1', ['nope']), 's1')).toEqual([]);
    expect(annotationsOf(base, null)).toEqual([]);
    const data = setSessionAnnotations(base, 's1', ['red']);
    expect(setSessionAnnotations(data, 's1', []).assignments).toEqual({});
  });

  it('toggle 来回去掉 / 加上同一项', () => {
    const on = toggleSessionAnnotation(base, 's1', 'blue');
    expect(annotationsOf(on, 's1')).toEqual(['blue']);
    expect(annotationsOf(toggleSessionAnnotation(on, 's1', 'blue'), 's1')).toEqual([]);
  });

  it('不改动传入的对象', () => {
    setSessionAnnotations(base, 's1', ['red']);
    expect(base.assignments).toEqual({});
  });
});

describe('resolveAnnotationOptions', () => {
  it('未知 id 丢掉，顺序跟随 assignments', () => {
    const data = normalizeSessionAnnotations({
      options: [
        { id: 'a', label: 'A', color: '#111111' },
        { id: 'b', label: 'B', color: '#222222' },
      ],
      assignments: { s1: ['b', 'gone'] },
    });
    expect(resolveAnnotationOptions(data, 's1').map((option) => option.id)).toEqual(['b']);
    expect(resolveAnnotationOptions(data, 'missing')).toEqual([]);
  });
});

describe('磁盘读写', () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'mica-annotations-'));
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it('写进插件自己的数据目录，再读回来一致', () => {
    const data: ReturnType<typeof normalizeSessionAnnotations> = {
      version: 1,
      name: 'Session Tags',
      options: [{ id: 'red', label: '红', color: '#FF3B30' }],
      assignments: { s1: ['red'] },
    };
    writeSessionAnnotations(home, 'session-tags', data);
    expect(sessionAnnotationsPath(home, 'session-tags')).toBe(
      join(pluginDataDir(home, 'session-tags'), 'session-annotations.json'),
    );
    expect(readSessionAnnotations(home, 'session-tags')).toEqual(data);
    // 落盘的是合法 JSON，用户手改能看懂。
    expect(JSON.parse(readFileSync(sessionAnnotationsPath(home, 'session-tags'), 'utf8')).name).toBe(
      'Session Tags',
    );
  });

  it('文件不存在 / 坏掉都返回空表，不抛错', () => {
    expect(readSessionAnnotations(home, 'nope').options).toEqual([]);
    mkdirSync(pluginDataDir(home, 'broken'), { recursive: true });
    writeFileSync(sessionAnnotationsPath(home, 'broken'), '{ not json', 'utf8');
    expect(readSessionAnnotations(home, 'broken').options).toEqual([]);
  });

  it('汇总所有插件，跳过没有 options 的、按目录名排序', () => {
    writeSessionAnnotations(home, 'b-plugin', {
      version: 1,
      name: 'B',
      options: [{ id: 'x', label: 'X', color: '#123456' }],
      assignments: {},
    });
    writeSessionAnnotations(home, 'a-plugin', {
      version: 1,
      name: 'A',
      options: [{ id: 'y', label: 'Y', color: '#654321' }],
      assignments: {},
    });
    writeSessionAnnotations(home, 'empty-plugin', normalizeSessionAnnotations({}));

    const providers = readAllSessionAnnotations(home);
    expect(providers.map((provider) => provider.pluginId)).toEqual(['a-plugin', 'b-plugin']);
  });

  it('plugin-data 目录还不存在时返回空数组', () => {
    expect(readAllSessionAnnotations(home)).toEqual([]);
  });
});
