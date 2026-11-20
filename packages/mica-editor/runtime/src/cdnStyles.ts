/**
 * Optional third-party styles are loaded with the feature that needs them.
 * Keep Arco's base sheet in the HTML entry point because every editor mode
 * renders Arco controls; the heavier feature sheets should not delay a plain
 * notebook from becoming interactive.
 */
export const EDITOR_OPTIONAL_STYLES = {
  katex: 'https://cdn.jsdelivr.net/npm/katex@0.16.10/dist/katex.css',
  excalidraw: 'https://cdn.jsdelivr.net/npm/@excalidraw/excalidraw@0.18.1/dist/prod/index.css',
  datePicker: 'https://cdn.jsdelivr.net/npm/react-day-picker@9.14.0/src/style.css',
} as const;

export type EditorOptionalStyle = keyof typeof EDITOR_OPTIONAL_STYLES;

/**
 * Add an optional stylesheet once. Appending the link synchronously is
 * intentional: lazy feature modules call this before their first render, and
 * the DOM query makes StrictMode remounts and multiple nodes idempotent.
 */
export function ensureEditorOptionalStyle(style: EditorOptionalStyle): void {
  if (typeof document === 'undefined') return;

  const href = EDITOR_OPTIONAL_STYLES[style];
  for (const link of document.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"]')) {
    if (link.href === href || link.getAttribute('href') === href) return;
  }

  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = href;
  link.crossOrigin = 'anonymous';
  link.dataset.micaEditorOptionalStyle = style;
  document.head.appendChild(link);
}
