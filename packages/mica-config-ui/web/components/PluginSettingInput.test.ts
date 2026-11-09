import { describe, expect, it, vi } from 'vitest';
import type { ConfigWebPluginSetting } from '../../src/shared/types.js';
import {
  PluginSettingInput,
  joinDirectorySetting,
  nudgeSettingValue,
  numberSettingInputValue,
  splitDirectorySetting,
} from './PluginSettingInput.js';
import { InputNumber } from './ArcoSettings.js';

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

  it('小数步长仍按原规则保留四位小数', () => {
    expect(nudgeSettingValue({ ...field, min: 0, step: 0.1 }, '0.2', 1)).toBe('0.3');
    expect(nudgeSettingValue({ ...field, min: 0, step: 0.00001 }, '0.1234', 1)).toBe('0.1234');
  });
});

describe('Arco number setting', () => {
  function input(value = '500', setting = field) {
    const onChange = vi.fn();
    const element = PluginSettingInput({ field: setting, value, disabled: false, invalid: false, onChange });
    expect(element.type).toBe(InputNumber);
    return { props: element.props, onChange };
  }

  it('保留上下限、步长、受控值与单位', () => {
    const { props } = input('500', { ...field, unit: 'K' });
    expect(props).toMatchObject({
      value: '500',
      'aria-valuemin': 150,
      'aria-valuemax': 10_000,
      step: 10,
      mode: 'button',
    });
    expect(props.min).toBeUndefined();
    expect(props.max).toBeUndefined();
    expect(props.suffix.props.children).toBe('K');
    expect(input('5', { ...field, step: undefined }).props.step).toBe(1);
  });

  it('手输超界值不夹断，失焦也不偷偷改值', () => {
    const { props, onChange } = input();
    props.onInput({ currentTarget: { value: '10001' } });
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenLastCalledWith('10001');
    props.onChange(10_000, 'manual');
    props.onChange(10_000, 'outOfRange');
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(props.formatter(10_000, { userTyping: true, input: '10001' })).toBe('10001');
    expect(props.formatter(10_000, { userTyping: false, input: '' })).toBe('500');
  });

  it('步进仍由原来的上下限规则取值', () => {
    const { props, onChange } = input('9995');
    props.onChange(10_005, 'increase');
    expect(onChange).toHaveBeenLastCalledWith('10000');
    const lower = input('155');
    lower.props.onChange(145, 'decrease');
    expect(lower.onChange).toHaveBeenLastCalledWith('150');
  });

  it('清空仍发空字符串，空值步进仍从下限加一个步长', () => {
    const { props, onChange } = input('');
    props.onInput({ currentTarget: { value: '' } });
    expect(onChange).toHaveBeenLastCalledWith('');
    props.onChange(150, 'increase');
    expect(onChange).toHaveBeenLastCalledWith('160');
    props.onChange(undefined, 'manual');
    expect(onChange).toHaveBeenCalledTimes(2);
  });

  it('数字输入保留格式，不把编辑中无效内容落成数字', () => {
    for (const text of ['001.50', '-2.5', '1e3', '.5']) expect(numberSettingInputValue(text)).toBe(text);
    for (const text of ['', '-', '.', '1e', 'Infinity', '0xff', '1_000'])
      expect(numberSettingInputValue(text)).toBe('');
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
