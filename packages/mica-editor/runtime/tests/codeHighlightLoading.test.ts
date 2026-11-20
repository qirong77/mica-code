import { $createCodeNode, $isCodeNode } from '@lexical/code-core';
import { buildEditorFromExtensions } from '@lexical/extension';
import { $createTextNode, $getRoot, configExtension, defineExtension } from 'lexical';
import { afterEach, describe, expect, it } from 'vitest';

import { CodeHighlightExtension } from '../src/playground/plugins/CodeHighlightExtension';
import {
  isCodeLanguageLoaded,
  loadCodeLanguage,
  Prism,
} from '../src/playground/plugins/CodeHighlightExtension/FacadePrism';

const editors: Array<{ dispose: () => void }> = [];

afterEach(() => {
  for (const editor of editors.splice(0)) editor.dispose();
});

describe('lazy code highlighting', () => {
  it('loads only the requested Prism grammar and makes it available to the facade', async () => {
    expect(isCodeLanguageLoaded('rust')).toBe(false);
    await loadCodeLanguage('rust');
    expect(isCodeLanguageLoaded('rust')).toBe(true);
    expect(typeof Prism.languages.rust).toBe('object');
  });

  it('highlights an existing code block after the lazy extension resolves', async () => {
    const editor = buildEditorFromExtensions(
      defineExtension({
        name: 'test/lazy-code-highlighting',
        dependencies: [configExtension(CodeHighlightExtension, { mode: 'prism' })],
      }),
    );
    editors.push(editor);

    editor.update(() => {
      $getRoot().append($createCodeNode('javascript').append($createTextNode('const value = 1;')));
    });

    for (let attempt = 0; attempt < 50; attempt++) {
      const highlighted = editor.read('latest', () =>
        (() => {
          const code = $getRoot().getChildren()[1];
          return $isCodeNode(code) && code.getChildren().some((node) => node.getType() === 'code-highlight');
        })(),
      );
      if (highlighted) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    throw new Error('Code highlighting did not resolve');
  });

  it('keeps Shiki available as an opt-in lazy engine', async () => {
    const editor = buildEditorFromExtensions(
      defineExtension({
        name: 'test/lazy-shiki-highlighting',
        dependencies: [configExtension(CodeHighlightExtension, { mode: 'shiki' })],
      }),
    );
    editors.push(editor);

    editor.update(() => {
      $getRoot().append($createCodeNode('javascript').append($createTextNode('const value = 1;')));
    });

    for (let attempt = 0; attempt < 100; attempt++) {
      const highlighted = editor.read('latest', () => {
        const code = $getRoot().getChildren()[1];
        return $isCodeNode(code) && code.getChildren().some((node) => node.getType() === 'code-highlight');
      });
      if (highlighted) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    throw new Error('Shiki highlighting did not resolve');
  });
});
