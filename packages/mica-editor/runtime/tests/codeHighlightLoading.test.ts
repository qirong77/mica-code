import { $createCodeNode, $isCodeNode } from '@lexical/code-core';
import { buildEditorFromExtensions } from '@lexical/extension';
import {createEmptyHistoryState, registerHistory} from '@lexical/history';
import { $createParagraphNode, $createTextNode, $getRoot, configExtension, defineExtension, HISTORY_PUSH_TAG, UNDO_COMMAND } from 'lexical';
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
  it('keeps lazy highlighting in the paste history entry so one undo removes the pasted code', async () => {
    const editor = buildEditorFromExtensions(defineExtension({
      name: 'test/code-paste-history',
      dependencies: [configExtension(CodeHighlightExtension, {mode: 'prism'})],
    }));
    const history = createEmptyHistoryState();
    const stopHistory = registerHistory(editor, history, 0);
    editors.push({dispose: () => { stopHistory(); editor.dispose(); }});
    editor.update(() => {
      $getRoot().clear().append($createParagraphNode().append($createTextNode('保留正文')));
    }, {discrete: true});
    editor.update(() => {
      $getRoot().append($createCodeNode('python').append($createTextNode('def greet():\n    print("hello")')));
    }, {discrete: true, tag: HISTORY_PUSH_TAG});
    for (let attempt = 0; attempt < 100; attempt++) {
      const highlighted = editor.read('latest', () => {
        const code = $getRoot().getLastChild();
        return $isCodeNode(code) && code.getChildren().some(node => node.getType() === 'code-highlight');
      });
      if (highlighted && isCodeLanguageLoaded('python')) break;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    expect(editor.read('latest', () => $getRoot().getChildren().some($isCodeNode))).toBe(true);
    editor.dispatchCommand(UNDO_COMMAND, undefined);
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(editor.read('latest', () => $getRoot().getTextContent())).toBe('保留正文');
    expect(editor.read('latest', () => $getRoot().getChildren().some($isCodeNode))).toBe(false);
  });

  it('loads only the requested Prism grammar and makes it available to the facade', async () => {
    expect(isCodeLanguageLoaded('rust')).toBe(false);
    await loadCodeLanguage('rust');
    expect(isCodeLanguageLoaded('rust')).toBe(true);
    expect(typeof Prism.languages.rust).toBe('object');
  });

  it('loads the bash grammar for shell code blocks', async () => {
    expect(isCodeLanguageLoaded('bash')).toBe(false);
    await loadCodeLanguage('bash');
    expect(isCodeLanguageLoaded('bash')).toBe(true);
    expect(typeof Prism.languages.bash).toBe('object');
    // sh / shell 与 bash 共用同一份语法。
    expect(isCodeLanguageLoaded('sh')).toBe(true);
    expect(isCodeLanguageLoaded('shell')).toBe(true);
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
