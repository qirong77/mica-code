/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {LINK, registerMarkdownShortcuts} from '@lexical/markdown';
import {COMMAND_PRIORITY_CRITICAL, defineExtension, type LexicalEditor, mergeRegister, SELECTION_CHANGE_COMMAND} from 'lexical';

import {PLAYGROUND_TRANSFORMERS} from '../MarkdownTransformers';
import {NOTEBOOK_LINK_SHORTCUT} from '../FloatingLinkEditorPlugin/linkShortcut';
import {$isNotebookTitleSelection} from '../../../workspace/notebookTitle';

const NOTEBOOK_SHORTCUTS = PLAYGROUND_TRANSFORMERS.map(transformer => transformer === LINK ? NOTEBOOK_LINK_SHORTCUT : transformer);

/** Title characters must remain literal, including Markdown trigger marks. */
export function registerNotebookMarkdownShortcuts(editor: LexicalEditor): () => void {
  let stopShortcuts: (() => void) | undefined;
  const sync = (inTitle: boolean) => {
    if (inTitle) {
      stopShortcuts?.();
      stopShortcuts = undefined;
    } else if (!stopShortcuts) {
      stopShortcuts = registerMarkdownShortcuts(editor, NOTEBOOK_SHORTCUTS);
    }
  };
  // Register the guard first so it also covers programmatic selections before
  // the shortcut update listener sees the typed trigger.
  const stopGuard = mergeRegister(
    editor.registerUpdateListener(({editorState}) => sync(editorState.read($isNotebookTitleSelection))),
    editor.registerCommand(SELECTION_CHANGE_COMMAND, () => {
      sync($isNotebookTitleSelection());
      return false;
    }, COMMAND_PRIORITY_CRITICAL),
  );
  sync(editor.getEditorState().read($isNotebookTitleSelection));
  return () => { stopGuard(); stopShortcuts?.(); };
}

// This is not a published extension because markdown transformers
// should get a refactor to require less manual configuration
export const PlaygroundMarkdownShortcutsExtension = defineExtension({
  name: '@lexical/playground/MarkdownShortcuts',
  register: registerNotebookMarkdownShortcuts,
});
