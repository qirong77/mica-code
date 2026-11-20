import { CodeIndentExtension, CodeNode } from '@lexical/code-core';
import { effect, namedSignals } from '@lexical/extension';
import { $nodesOfType, type LexicalEditor, mergeRegister } from 'lexical';
import { configExtension, defineExtension, safeCast } from 'lexical';

export type CodeHighlightMode = 'off' | 'prism' | 'shiki';

export interface CodeHighlightConfig {
  mode: CodeHighlightMode;
}

type HighlightCleanup = () => void;

/**
 * Load the selected highlighter only after a document actually contains a
 * code block. Prism and Shiki both have sizeable module graphs; importing
 * either in the editor extension's static dependency list made a plain note
 * pay for syntax highlighting it never used.
 */
async function registerHighlighting(
  editor: LexicalEditor,
  mode: Exclude<CodeHighlightMode, 'off'>,
): Promise<HighlightCleanup> {
  if (mode === 'prism') {
    const { PrismTokenizer, refreshCodeHighlighting, registerHighlightingOnly } =
      await import('./CodeHighlighterPrism');
    const cleanup = registerHighlightingOnly(editor, {
      ...PrismTokenizer,
      defaultLanguage: null,
    });
    refreshCodeHighlighting(editor);
    return cleanup;
  }

  const { refreshCodeHighlighting, registerHighlightingOnly, ShikiTokenizer } = await import('./CodeHighlighterShiki');
  const cleanup = registerHighlightingOnly(editor, {
    ...ShikiTokenizer,
    defaultLanguage: null,
  });
  refreshCodeHighlighting(editor);
  return cleanup;
}

/**
 * A small runtime switch around the two local Lexical highlighter adapters.
 * CodeIndentExtension remains available even while highlighting is disabled;
 * turning highlighting off therefore does not remove Tab/arrow editing.
 */
export const CodeHighlightExtension = defineExtension({
  build: (editor, config) => namedSignals(config),
  config: safeCast<CodeHighlightConfig>({ mode: 'off' }),
  dependencies: [
    configExtension(CodeIndentExtension, {
      escapeWithArrows: true,
      tabSize: 2,
    }),
  ],
  name: '@lexical/playground/CodeHighlight',
  register: (editor, _config, state) => {
    let cleanup: HighlightCleanup | undefined;
    let requestId = 0;
    let hasCode = false;
    const readHasCode = () => editor.getEditorState().read(() => $nodesOfType(CodeNode).length > 0);
    const ensureHighlighting = () => {
      const mode = state.getOutput().mode.value;
      if (mode === 'off' || !hasCode) {
        requestId++;
        cleanup?.();
        cleanup = undefined;
        return;
      }

      const currentRequest = ++requestId;
      cleanup?.();
      cleanup = undefined;

      void registerHighlighting(editor, mode)
        .then((nextCleanup) => {
          if (currentRequest !== requestId || state.getOutput().mode.value !== mode || !hasCode) {
            nextCleanup();
            return;
          }
          cleanup = nextCleanup;
        })
        .catch((error) => {
          if (currentRequest === requestId) {
            console.warn('代码高亮模块加载失败，将保留纯文本代码块。', error);
          }
        });
    };

    const refreshCodePresence = () => {
      // Mutation listeners are the cheap path in a DOM editor. The update
      // listener below is also kept until the first code block appears so
      // headless editors (which have no root element) take the same path.
      const nextHasCode = readHasCode();
      if (nextHasCode === hasCode) return;
      hasCode = nextHasCode;
      ensureHighlighting();
    };

    return mergeRegister(
      effect(ensureHighlighting),
      editor.registerMutationListener(CodeNode, refreshCodePresence),
      editor.registerUpdateListener(({ editorState }) => {
        if (hasCode) return;
        const nextHasCode = editorState.read(() => $nodesOfType(CodeNode).length > 0);
        if (!nextHasCode) return;
        hasCode = true;
        ensureHighlighting();
      }),
      () => {
        requestId++;
        cleanup?.();
        cleanup = undefined;
      },
    );
  },
});
