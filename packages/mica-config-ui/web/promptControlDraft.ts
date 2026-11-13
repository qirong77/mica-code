import {
  orderPromptSections,
  type PromptControls,
  type PromptSectionSnapshot,
} from '@packages/mica-common/promptControls.js';
import { wrapPromptXml } from '@packages/mica-common/promptXml.js';

export function effectivePromptSection(section: PromptSectionSnapshot, controls: PromptControls) {
  if (section.id === 'system') return { ...section, enabled: true, content: section.originalContent };
  const override = controls.sections[section.id];
  return {
    ...section,
    enabled: override?.enabled !== false && (!section.pluginId || !controls.disabledPlugins.includes(section.pluginId)),
    content: override?.content ?? section.originalContent,
  };
}

/** 界面、预览和下一轮拼装共用同一份排序，拖动后不必等回读就能看到新顺序。 */
export function orderedPromptSections(
  sections: PromptSectionSnapshot[],
  controls: PromptControls,
): PromptSectionSnapshot[] {
  return orderPromptSections(sections, controls.order);
}

/**
 * 把一段拖到另一段之前或之后，返回新的顺序表。
 *
 * 顺序表只装可编辑段落：`system` 是只读基底且要留在稳定前缀里，永远排在最前。
 */
export function movePromptSection(
  sections: PromptSectionSnapshot[],
  controls: PromptControls,
  draggedId: string,
  targetId: string,
  position: 'before' | 'after',
): PromptControls {
  if (draggedId === targetId) return controls;
  const ids = orderedPromptSections(sections, controls)
    .filter((section) => section.editable)
    .map((section) => section.id);
  if (!ids.includes(draggedId) || !ids.includes(targetId)) return controls;
  const next = ids.filter((id) => id !== draggedId);
  const target = next.indexOf(targetId);
  next.splice(position === 'after' ? target + 1 : target, 0, draggedId);
  return { ...controls, order: next };
}

/** 使用运行时返回的顺序和原文；预览草稿不会改写最近实际发送的存档。 */
export function previewPrompt(sections: PromptSectionSnapshot[], controls: PromptControls): string {
  return orderedPromptSections(sections, controls)
    .map((section) => effectivePromptSection(section, controls))
    .filter((section) => section.enabled && section.content.trim())
    .map((section) =>
      section.pluginId
        ? wrapPromptXml('injection', section.content.trim(), {
            source: 'plugin',
            plugin: section.pluginId,
            section: section.sectionId ?? '',
          })
        : wrapPromptXml(section.id, section.content.trim()),
    )
    .join('\n\n');
}

export function setPromptSection(
  controls: PromptControls,
  id: string,
  patch: { enabled?: boolean; content?: string },
): PromptControls {
  return { ...controls, sections: { ...controls.sections, [id]: { ...controls.sections[id], ...patch } } };
}

export function restorePromptSection(controls: PromptControls, id: string): PromptControls {
  const sections = { ...controls.sections };
  const enabled = sections[id]?.enabled;
  delete sections[id];
  if (enabled === false) sections[id] = { enabled: false };
  return { ...controls, sections };
}

export function setPluginPromptEnabled(controls: PromptControls, pluginId: string, enabled: boolean): PromptControls {
  const disabled = new Set(controls.disabledPlugins);
  if (enabled) disabled.delete(pluginId);
  else disabled.add(pluginId);
  return { ...controls, disabledPlugins: [...disabled] };
}
