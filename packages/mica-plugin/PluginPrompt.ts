import type { Disposable } from '@packages/mica-common/index.js';
import { wrapPromptXml } from '@packages/mica-common/promptXml.js';
import {
  orderPromptSections,
  promptSectionKey,
  type PromptControls,
  type PromptSectionSnapshot,
} from '@packages/mica-common/promptControls.js';

/**
 * 插件向 system prompt 贡献的一段文字。
 *
 * 段落每轮重新渲染，所以插件可以把自己的状态（会话笔记、循环任务说明、项目约定）
 * 注入进去，而不需要内核为每个插件写一段硬编码的拼接逻辑。渲染结果为空串表示本轮
 * 不贡献内容（例如笔记还没写）。
 *
 * 追加位置固定在 base prompt（system / AGENT.md / skills）之后。宿主统一添加带来源
 * 属性的 XML injection 边界，正文可包含其他 XML 标签。这些段落放在末尾，避免稳定的
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

  /** 每段正文只求值一次；空段落也保留，便于检查动态注入与编辑覆盖。 */
  inspect(controls?: PromptControls): PromptSectionSnapshot[] {
    const ordered = [...this.sections].sort(
      (a, b) => (a.section.order ?? 0) - (b.section.order ?? 0) || a.sequence - b.sequence,
    );
    const snapshots = ordered.map((item) => {
      const text = item.section.render();
      const originalContent = typeof text === 'string' ? text.trim() : '';
      const id = promptSectionKey(item.pluginId, item.section.id);
      const override = controls?.sections[id];
      return {
        id,
        label: item.section.id,
        pluginId: item.pluginId,
        sectionId: item.section.id,
        originalContent,
        content: (override?.content ?? originalContent).trim(),
        enabled: !controls?.disabledPlugins.includes(item.pluginId) && override?.enabled !== false,
        editable: true,
      };
    });
    // 注册顺序之后才是用户拖拽出来的顺序：前者是插件的默认，后者是人的决定。
    return orderPromptSections(snapshots, controls?.order);
  }

  /** 按与 inspect 相同的快照拼装，空段落与禁用段落跳过。 */
  render(controls?: PromptControls): string {
    return renderPluginPromptSections(this.inspect(controls));
  }

  getPluginIds(): string[] {
    return [...new Set(this.sections.map((item) => item.pluginId))];
  }

  getSectionIds(pluginId: string): string[] {
    return this.sections.filter((item) => item.pluginId === pluginId).map((item) => item.section.id);
  }

  clear(): void {
    this.sections = [];
  }

  get size(): number {
    return this.sections.length;
  }
}

/** Reuse an inspected snapshot without evaluating dynamic plugin callbacks twice. */
export function renderPluginPromptSections(sections: PromptSectionSnapshot[]): string {
  return sections
    .filter((section) => section.enabled && section.content.trim())
    .map((section) =>
      wrapPromptXml('injection', section.content, {
        source: 'plugin',
        plugin: section.pluginId!,
        section: section.sectionId!,
      }),
    )
    .join('\n\n');
}
