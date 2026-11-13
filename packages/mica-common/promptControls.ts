/** Global prompt customizations, applied when a new turn starts. */
export type PromptControls = {
  version: 1;
  disabledPlugins: string[];
  sections: Record<string, { enabled?: boolean; content?: string }>;
};

export type PromptSectionSnapshot = {
  id: string;
  label: string;
  pluginId?: string;
  sectionId?: string;
  originalContent: string;
  content: string;
  enabled: boolean;
  editable: boolean;
};

export type RuntimePromptInspection = {
  cwd: string;
  role: string;
  running: boolean;
  /** Preview using the current global controls; changes take effect next turn. */
  preview: string;
  lastSent: string | null;
  sections: PromptSectionSnapshot[];
};

export function promptSectionKey(pluginId: string, sectionId: string): string {
  return `plugin:${pluginId}/${sectionId}`;
}
