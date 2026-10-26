import type { Disposable } from '@packages/mica-common/index.js';

/**
 * 插件向 system prompt 贡献的一段文字。
 *
 * 段落每轮重新渲染，所以插件可以把自己的状态（会话笔记、循环任务说明、项目约定）
 * 注入进去，而不需要内核为每个插件写一段硬编码的拼接逻辑。渲染结果为空串表示本轮
 * 不贡献内容（例如笔记还没写）。
 *
 * 追加位置固定在 base prompt（system / AGENT.md / skills）与 `system-prompt:build`
 * pipeline 之后：这些段落是最容易随会话变化的部分，放在末尾才不会让前面稳定的
 * 前缀跟着 prompt cache 一起失效。
 */
export type PluginPromptSection = {
  /** 插件内唯一，重复注册时报错。 */
  id: string;
  /** 越小越靠前；相同 order 按注册顺序。 */
  order?: number;
  render(): string;
};

type RegisteredSection = {
  pluginId: string;
  section: PluginPromptSection;
  sequence: number;
};

/**
 * prompt 段落登记表。内核持有一份，插件通过 `ctx.prompt.section()` 写入。
 *
 * 卸载插件时只移除它自己的段落：`prompt` 是全局可见的，一个插件停用不能把别的
 * 插件贡献的内容也带走。
 */
export class PluginPromptSections {
  private sections: RegisteredSection[] = [];
  private sequence = 0;

  add(pluginId: string, section: PluginPromptSection): Disposable {
    const duplicate = this.sections.find((item) => item.pluginId === pluginId && item.section.id === section.id);
    if (duplicate) {
      throw new Error(`prompt section already registered: ${pluginId}/${section.id}`);
    }
    const registered: RegisteredSection = { pluginId, section, sequence: ++this.sequence };
    this.sections.push(registered);
    return {
      dispose: () => {
        this.sections = this.sections.filter((item) => item !== registered);
      },
    };
  }

  /** 按 order、注册顺序拼成一段，空段落跳过。 */
  render(): string {
    const ordered = [...this.sections].sort(
      (a, b) => (a.section.order ?? 0) - (b.section.order ?? 0) || a.sequence - b.sequence,
    );
    const parts: string[] = [];
    for (const item of ordered) {
      const text = item.section.render();
      const trimmed = typeof text === 'string' ? text.trim() : '';
      if (trimmed) parts.push(trimmed);
    }
    return parts.join('\n\n');
  }

  clear(): void {
    this.sections = [];
  }

  get size(): number {
    return this.sections.length;
  }
}
