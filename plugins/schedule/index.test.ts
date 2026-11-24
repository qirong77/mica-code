import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import type { PluginContext } from '@packages/mica-plugin/index.js';
import setup from './index.js';
import manifest from './plugin.json';

it('loads without a tools capability and only logs where the data lives', () => {
  const info = vi.fn();
  const context = {
    pluginId: 'schedule',
    paths: { home: '/mica-home', config: '/mica-home', plugins: '/mica-home/plugins' },
    logger: { info },
  } as unknown as PluginContext;

  expect(() => setup(context)).not.toThrow();
  expect(info).toHaveBeenCalledExactlyOnceWith('schedule:ready', {
    file: join('/mica-home', 'plugin-data', 'schedule', 'data.json'),
  });
});

it('declares the machine-readable api instead of a tool', () => {
  expect(manifest.api).toBe(true);
  expect(manifest.requires).toEqual([]);
  expect(manifest.uriApis).toHaveLength(1);

  const [entry] = manifest.uriApis;
  expect(entry).toEqual({
    name: 'schedule',
    description: expect.any(String),
    uri: '/plugin/schedule/api',
  });
  // 浮层里的标签不能带空白，描述要一行说清能力
  expect(entry!.name).not.toMatch(/\s/);
  expect(entry!.description.trim()).toBe(entry!.description);
  expect(entry!.description.length).toBeGreaterThan(0);
});
