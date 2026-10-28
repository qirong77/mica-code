import { afterEach, describe, expect, it } from 'vitest';
import { micaTools } from '@packages/mica-tools/index.js';
import { RUNTIME_TOOL_DESCRIPTORS } from '@packages/mica-tools/runtimeToolDescriptors.js';
import { TodoWriteTool } from '@plugins/todo/TodoTool.js';
import { SessionNotesTool } from '../../../../plugins/session-notes/NotesTool.js';
import { ToolSessionPeers } from '@packages/mica-builtin-commands/plugins/session-autonomy/SessionAutonomyTools.js';
import { AgentTool } from '@plugins/subagent/AgentTool.js';
import { BUILTIN_SUBAGENTS } from '@plugins/subagent/definitions.js';
import { HarnessReviewTool } from '@plugins/harness-review/index.js';

/**
 * 运行期工具在配置页 / 桌面设置页的目录里靠 `RUNTIME_TOOL_DESCRIPTORS` 兜底（那些进程不加载插件）。
 * 兜底描述与工具类本身必须一致，否则两个面板会对同一个工具显示不同的说明与入参。
 */
const FACTORIES: Record<string, () => { name: string }> = {
  harness_review: () => new HarnessReviewTool(async () => ({})),
  // `agent` 由官方插件 subagent 注册；这里只需要一个能列出内置类型的桩，
  // 描述里的类型清单就是唯一随注册内容变化的部分。
  agent: () => new AgentTool({ listTypes: () => BUILTIN_SUBAGENTS } as never),
  todo_write: () => new TodoWriteTool(),
  session_notes: () => new SessionNotesTool(),
  session_peers: () => new ToolSessionPeers({ services: {} as never }),
};

describe('runtime tool descriptors', () => {
  afterEach(() => {
    micaTools.unregisterAllRuntime();
  });

  it('every descriptor has a live tool factory', () => {
    for (const descriptor of RUNTIME_TOOL_DESCRIPTORS) {
      expect(Object.keys(FACTORIES), descriptor.name).toContain(descriptor.name);
    }
  });

  it.each(RUNTIME_TOOL_DESCRIPTORS.map((descriptor) => [descriptor.name] as const))(
    '%s matches the real tool (description / readOnly / parameters)',
    (name) => {
      const factory = FACTORIES[name];
      if (!factory) throw new Error(`missing factory for ${name}`);
      micaTools.registerRuntime(factory() as never);
      const actual = micaTools.getCatalog().find((tool) => tool.name === name);
      expect(actual).toBeTruthy();
      const descriptor = RUNTIME_TOOL_DESCRIPTORS.find((entry) => entry.name === name)!;
      expect(actual!.description).toBe(descriptor.description);
      expect(actual!.readOnly).toBe(descriptor.readOnly);
      expect(actual!.parameters).toEqual(descriptor.parameters);
    },
  );
});
