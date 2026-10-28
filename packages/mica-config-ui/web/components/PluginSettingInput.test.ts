import { describe, expect, it } from 'vitest';
import type { ConfigWebPluginSetting } from '../../src/shared/types.js';
import { nudgeSettingValue } from './PluginSettingInput.js';

const field: ConfigWebPluginSetting = {
  key: 'quickThresholdK',
  label: '快速压缩阈值',
  type: 'number',
  min: 150,
  max: 10_000,
  step: 10,
};

describe('nudgeSettingValue', () => {
  it('加就是加，减就是减', () => {
    expect(nudgeSettingValue(field, '500', 1)).toBe('510');
    expect(nudgeSettingValue(field, '500', -1)).toBe('490');
  });

  it('上下限各自生效', () => {
    expect(nudgeSettingValue(field, '9995', 1)).toBe('10000');
    expect(nudgeSettingValue(field, '155', -1)).toBe('150');
  });

  it('空值从下限起步，不产生 NaN', () => {
    expect(nudgeSettingValue(field, '', 1)).toBe('160');
  });

  it('没有上下限时只做加减', () => {
    expect(nudgeSettingValue({ ...field, min: undefined, max: undefined }, '5', 1)).toBe('15');
  });
});
