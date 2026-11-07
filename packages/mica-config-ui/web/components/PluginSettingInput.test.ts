import { describe, expect, it } from 'vitest';
import type { ConfigWebPluginSetting } from '../../src/shared/types.js';
import { joinDirectorySetting, nudgeSettingValue, splitDirectorySetting } from './PluginSettingInput.js';

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

describe('目录列表字段的取值', () => {
  it('一行一个目录，空行不占位', () => {
    expect(splitDirectorySetting('~/Desktop\n\n~/Downloads\n')).toEqual(['~/Desktop', '~/Downloads']);
  });

  it('空值是空列表，不是一条空目录', () => {
    expect(splitDirectorySetting('')).toEqual([]);
    expect(splitDirectorySetting('\n  \n')).toEqual([]);
  });

  it('回写时去掉空行与首尾空白，插件的解析结果不变', () => {
    expect(joinDirectorySetting([' ~/Desktop ', '', '~/Downloads'])).toBe('~/Desktop\n~/Downloads');
  });

  it('两个方向来回一趟还是原值', () => {
    const stored = '~/Desktop\n/Volumes/work';
    expect(joinDirectorySetting(splitDirectorySetting(stored))).toBe(stored);
  });
});
