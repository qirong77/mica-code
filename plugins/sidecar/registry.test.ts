import { describe, expect, it } from 'vitest';
import { resolveSidecarRole } from './registry.js';

describe('resolveSidecarRole', () => {
  it('uses the explicitly requested role', () => {
    expect(resolveSidecarRole('paimon-bot', '需求开发')).toBe('paimon-bot');
  });

  it('inherits the parent role when none is requested', () => {
    // 子会话是「同一个 agent 换个上下文」；回落到 default 会让它换一套行为规则。
    expect(resolveSidecarRole(undefined, '需求开发')).toBe('需求开发');
  });

  it('ignores a blank explicit role and still inherits', () => {
    // 模型经常传空串而不是省略字段，不能因此丢掉父角色。
    expect(resolveSidecarRole('   ', '需求开发')).toBe('需求开发');
    expect(resolveSidecarRole('', '需求开发')).toBe('需求开发');
  });

  it('returns undefined when neither side names a role', () => {
    // undefined 让宿主用自己的默认值，而不是硬塞一个名字。
    expect(resolveSidecarRole(undefined, undefined)).toBeUndefined();
    expect(resolveSidecarRole('  ', '  ')).toBeUndefined();
  });

  it('trims before comparing so a padded name still wins', () => {
    expect(resolveSidecarRole('  paimon-bot  ', '需求开发')).toBe('paimon-bot');
  });
});
