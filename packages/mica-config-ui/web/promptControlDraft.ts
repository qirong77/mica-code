import type { PromptControls, PromptSectionSnapshot } from '@packages/mica-common/promptControls.js';
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

/** 使用运行时返回的顺序和原文；预览草稿不会改写最近实际发送的存档。 */
export function previewPrompt(sections: PromptSectionSnapshot[], controls: PromptControls): string {
  return sections
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
