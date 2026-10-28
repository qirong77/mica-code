import { describe, expect, it } from 'vitest';
import { resolveUseMainProvider } from './pluginLlm.js';

describe('resolveUseMainProvider', () => {
  it('不声明 followMain 的插件永远用自己的接口', () => {
    expect(resolveUseMainProvider(undefined, {})).toBe(false);
    expect(resolveUseMainProvider(false, {})).toBe(false);
  });

  it('没表态时留空就是跟随主配置', () => {
    expect(resolveUseMainProvider(true, {})).toBe(true);
    expect(resolveUseMainProvider(true, { baseUrl: '  ' })).toBe(true);
    expect(resolveUseMainProvider(true, { baseUrl: 'https://x.test' })).toBe(false);
  });

  it('显式拨过的开关压过地址推断', () => {
    expect(resolveUseMainProvider(true, { useMainProvider: 'true', baseUrl: 'https://x.test' })).toBe(true);
    expect(resolveUseMainProvider(true, { useMainProvider: 'false' })).toBe(false);
  });
});
