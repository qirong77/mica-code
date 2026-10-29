import { describe, expect, it } from 'vitest';
import {
  PluginSessionMenuRegistry,
  normalizePluginSessionMenuInput,
  normalizePluginSessionMenuResult,
} from './PluginSessionMenu.js';

describe('normalizePluginSessionMenuInput', () => {
  it('keeps the action and an optional session id', () => {
    expect(normalizePluginSessionMenuInput({ action: ' copy ', sessionId: ' s1 ' })).toEqual({
      action: 'copy',
      sessionId: 's1',
    });
    expect(normalizePluginSessionMenuInput({ action: 'copy' })).toEqual({ action: 'copy' });
  });

  // 没有动作 id 就不知道点了哪一项，只能拒绝
  it('rejects a missing or blank action', () => {
    expect(normalizePluginSessionMenuInput({})).toBeNull();
    expect(normalizePluginSessionMenuInput({ action: '   ' })).toBeNull();
    expect(normalizePluginSessionMenuInput(null)).toBeNull();
  });
});

describe('normalizePluginSessionMenuResult', () => {
  it('passes copy text through untouched', () => {
    const text = '# 会话\n\n- 路径：/tmp\n';
    expect(normalizePluginSessionMenuResult({ copyText: text, message: '已复制' })).toEqual({
      copyText: text,
      message: '已复制',
    });
  });

  // 剪贴板内容是用户要的东西，截断等于把功能做坏
  it('does not truncate copy text', () => {
    const long = 'x'.repeat(200_000);
    expect(normalizePluginSessionMenuResult({ copyText: long }).copyText).toHaveLength(200_000);
  });

  it('collapses a long message and drops unknown fields', () => {
    const result = normalizePluginSessionMenuResult({ message: 'a'.repeat(400), extra: 1 });
    expect(result.message?.endsWith('…')).toBe(true);
    expect(result.message?.length).toBe(200);
    expect(result).not.toHaveProperty('extra');
  });

  it('treats a non-string result as "nothing to say"', () => {
    expect(normalizePluginSessionMenuResult(undefined)).toEqual({});
    expect(normalizePluginSessionMenuResult({ copyText: 42 })).toEqual({});
  });
});

describe('PluginSessionMenuRegistry', () => {
  it('replaces an earlier handler of the same plugin', () => {
    const registry = new PluginSessionMenuRegistry();
    const first = { run: () => ({ message: 'first' }) };
    const second = { run: () => ({ message: 'second' }) };
    registry.add('demo', first);
    registry.add('demo', second);
    expect(registry.get('demo')).toBe(second);
    expect(registry.ids()).toEqual(['demo']);
  });

  // 卸载旧注册不能把新注册一起摘掉
  it('only disposes the registration that owns the current handler', () => {
    const registry = new PluginSessionMenuRegistry();
    const old = registry.add('demo', { run: () => ({}) });
    registry.add('demo', { run: () => ({}) });
    old.dispose();
    expect(registry.get('demo')).not.toBeNull();
    expect(registry.ids()).toEqual(['demo']);
  });
});
