import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  resetToolCatalogProjectionCache,
  readToolCatalogProjection,
  toolCatalogProjectionPath,
  writeToolCatalogProjection,
  type ToolCatalogProjectionEntry,
} from '../toolCatalogProjection.js';
import {
  getToolCatalogProjection,
  publishToolCatalog,
  registerRuntimeTool,
  unregisterRuntimeTool,
  unregisterRuntimeTools,
} from '../registry.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'mica-tool-projection-'));
  resetToolCatalogProjectionCache();
});

afterEach(() => {
  unregisterRuntimeTools();
  publishToolCatalog(null);
  resetToolCatalogProjectionCache();
  rmSync(dir, { recursive: true, force: true });
});

/** 等投影的合并写盘（注册后进 microtask）落地。 */
async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function subagentTool(name = 'subagent_open') {
  return registerRuntimeTool(
    {
      name,
      description: '开一个子会话',
      input_schema: { type: 'object', properties: { prompt: { type: 'string', description: '任务' } } },
      execute: async () => 'ok',
    },
    { group: { key: 'plugin:subagent', label: 'Subagent' }, icon: '🌱' },
  );
}

describe('tool catalog projection', () => {
  it('only projects tools that carry a plugin owner', () => {
    subagentTool();
    registerRuntimeTool({
      name: 'loose_tool',
      description: '没有插件归属',
      input_schema: { type: 'object' },
      execute: async () => 'ok',
    });

    expect(getToolCatalogProjection().map((entry) => entry.name)).toEqual(['subagent_open']);
    expect(getToolCatalogProjection()[0]).toMatchObject({
      pluginId: 'subagent',
      group: { key: 'plugin:subagent', label: 'Subagent' },
      icon: '🌱',
      parameters: [{ name: 'prompt', type: 'string', required: false, description: '任务' }],
    });
  });

  it('writes the projection as soon as a plugin tool is registered', async () => {
    publishToolCatalog(dir);
    subagentTool();
    await flush();

    expect(readToolCatalogProjection(dir)).toEqual([
      {
        name: 'subagent_open',
        description: '开一个子会话',
        readOnly: false,
        parameters: [{ name: 'prompt', type: 'string', required: false, description: '任务' }],
        group: { key: 'plugin:subagent', label: 'Subagent' },
        pluginId: 'subagent',
        icon: '🌱',
      },
    ]);
    expect(JSON.parse(readFileSync(toolCatalogProjectionPath(dir), 'utf-8')).version).toBe(1);
  });

  it('drops the whole plugin group once its tools are unregistered', async () => {
    publishToolCatalog(dir);
    const tool = subagentTool();
    await flush();
    expect(readToolCatalogProjection(dir)).toHaveLength(1);

    unregisterRuntimeTool(tool);
    await flush();
    expect(readToolCatalogProjection(dir)).toEqual([]);
  });

  it('keeps entries written by another host for plugins it did not assemble', async () => {
    const other: ToolCatalogProjectionEntry = {
      name: 'ask_user',
      description: '问一个问题',
      readOnly: false,
      parameters: [],
      group: { key: 'plugin:ask', label: 'Ask' },
      pluginId: 'ask',
    };
    writeToolCatalogProjection([other], dir);

    publishToolCatalog(dir);
    subagentTool();
    await flush();

    expect(readToolCatalogProjection(dir).map((entry) => entry.name)).toEqual(['ask_user', 'subagent_open']);
  });

  it('ignores broken files instead of failing the catalog', () => {
    writeFileSync(toolCatalogProjectionPath(dir), '{broken');
    expect(readToolCatalogProjection(dir)).toEqual([]);

    writeFileSync(toolCatalogProjectionPath(dir), JSON.stringify({ version: 2, tools: [{ name: 'x' }] }));
    expect(readToolCatalogProjection(dir)).toEqual([]);
  });
});
