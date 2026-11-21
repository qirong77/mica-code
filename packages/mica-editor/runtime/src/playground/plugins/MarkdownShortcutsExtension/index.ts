/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {LINK, registerMarkdownShortcuts} from '@lexical/markdown';
import {defineExtension} from 'lexical';

import {PLAYGROUND_TRANSFORMERS} from '../MarkdownTransformers';
import {NOTEBOOK_LINK_SHORTCUT} from '../FloatingLinkEditorPlugin/linkShortcut';

const NOTEBOOK_SHORTCUTS = PLAYGROUND_TRANSFORMERS.map(transformer => transformer === LINK ? NOTEBOOK_LINK_SHORTCUT : transformer);

// This is not a published extension because markdown transformers
// should get a refactor to require less manual configuration
export const PlaygroundMarkdownShortcutsExtension = defineExtension({
  name: '@lexical/playground/MarkdownShortcuts',
  register: editor =>
    registerMarkdownShortcuts(editor, NOTEBOOK_SHORTCUTS),
});
