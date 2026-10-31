import { describe, expect, it } from 'vitest';
import { resolveUseMainProvider } from './pluginLlm.js';

describe('resolveUseMainProvider', () => {
  it('没拨开关就复用当前会话模型', () => {
    expect(resolveUseMainProvider({})).toBe(true);
    expect(resolveUseMainProvider({ useMainProvider: '' })).toBe(true);
    // 填了自己的地址也不改变默认：要不要用自己那份，只看开关。
    expect(resolveUseMainProvider({ baseUrl: 'https://x.test' })).toBe(true);
  });

  it('只有明确关掉才用自己的接口', () => {
    expect(resolveUseMainProvider({ useMainProvider: 'true' })).toBe(true);
    expect(resolveUseMainProvider({ useMainProvider: 'false' })).toBe(false);
    expect(resolveUseMainProvider({ useMainProvider: 'false', baseUrl: 'https://x.test' })).toBe(false);
  });
});
