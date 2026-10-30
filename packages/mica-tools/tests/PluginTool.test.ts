import { describe, expect, it } from 'vitest';
import { createPluginTool } from '../PluginTool.js';
import type { PluginToolDescriptor } from '../PluginTool.js';
import { MicaTool } from '../MicaTool.js';
import { micaTools } from '../index.js';

describe('createPluginTool', () => {
  it('把纯描述包成可执行的工具', async () => {
    const tool = createPluginTool({
      name: 'demo_tool',
      description: '演示',
      input_schema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
      execute: (input) => `收到 ${input.text}`,
    });
    expect(tool).toBeInstanceOf(MicaTool);
    expect(tool.name).toBe('demo_tool');
    expect(tool.readOnly).toBe(false);
    expect(await tool.execute({ text: 'hi' })).toBe('收到 hi');
  });

  it('沿用基类的参数校验，缺必填项直接给出可读错误', () => {
    const tool = createPluginTool({
      name: 'demo_tool',
      description: '演示',
      input_schema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
      execute: () => 'ok',
    });
    const result = tool.validateInput({});
    expect(result.valid).toBe(false);
    expect(result.message).toContain('text');
  });

  it('展示文案缺省用工具名，抛错也不让调用失败', () => {
    const plain = createPluginTool({
      name: 'demo_tool',
      description: '',
      input_schema: { type: 'object' },
      execute: () => 'ok',
    });
    expect(plain.onToolUseDisplayText({})).toBe('demo_tool');
    const broken = createPluginTool({
      name: 'demo_tool',
      description: '',
      input_schema: { type: 'object' },
      execute: () => 'ok',
      displayText: () => {
        throw new Error('boom');
      },
    });
    expect(broken.onToolUseDisplayText({})).toBe('demo_tool');
  });

  it('读只读与等待标记原样带上，供并发与重试判断', () => {
    const tool = createPluginTool({
      name: 'demo_query',
      description: '',
      input_schema: { type: 'object' },
      readOnly: true,
      overlappable: true,
      execute: () => 'ok',
    });
    expect(tool.readOnly).toBe(true);
    expect(tool.canOverlap({})).toBe(true);
  });

  it('缺 name 或 execute 时立刻报错，而不是注册一个跑不起来的工具', () => {
    expect(() => createPluginTool({ name: '', description: '', input_schema: {}, execute: () => '' })).toThrow(/name/);
    // 插件是纯 JS，跑起来才可能缺字段；这里按「从外面拿进来的一坨」校验
    const missingExecute = { name: 'x', description: '', input_schema: {} } as unknown as PluginToolDescriptor;
    expect(() => createPluginTool(missingExecute)).toThrow(/execute/);
  });
});

describe('registerRuntime 收纯描述', () => {
  it('返回真正注册的实例，反注册要用它', async () => {
    const descriptor = {
      name: 'plugin_descriptor_demo',
      description: '演示',
      input_schema: { type: 'object', properties: {}, required: [] },
      execute: () => 'hello',
    };
    const registered = micaTools.registerRuntime(descriptor);
    expect(registered).toBeInstanceOf(MicaTool);
    expect(registered).not.toBe(descriptor);
    expect(micaTools.getCatalog().some((entry) => entry.name === 'plugin_descriptor_demo')).toBe(true);

    // 拿描述对象去反注册是错的：registry 里存的是包装后的实例
    micaTools.unregisterRuntime(descriptor as unknown as MicaTool);
    expect(micaTools.getCatalog().some((entry) => entry.name === 'plugin_descriptor_demo')).toBe(true);

    micaTools.unregisterRuntime(registered);
    expect(micaTools.getCatalog().some((entry) => entry.name === 'plugin_descriptor_demo')).toBe(false);
  });

  it('已经是 MicaTool 实例的照旧按原对象注册', async () => {
    class DemoTool extends MicaTool {
      constructor() {
        super('plugin_instance_demo', '演示', { type: 'object' });
      }

      execute() {
        return Promise.resolve('ok');
      }

      onToolUseDisplayText() {
        return '演示';
      }
    }
    const instance = new DemoTool();
    const registered = micaTools.registerRuntime(instance);
    expect(registered).toBe(instance);
    micaTools.unregisterRuntime(registered);
  });
});
