/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import { getExtensionDependencyFromEditor, signal } from '@lexical/extension';
import { CharacterLimitPlugin } from '@lexical/react/LexicalCharacterLimitPlugin';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import { useSignalValue } from '@lexical/react/useExtensionSignalValue';
import { CAN_USE_DOM, registerEventListener } from 'lexical';
import { type JSX, useCallback, useEffect, useMemo, useState } from 'react';

import { useSettings } from './context/SettingsContext';
import { useSynchronizeSettings } from './hooks/useSynchronizeSettings';
import AutoEmbedPlugin from './plugins/AutoEmbedPlugin';
import ComponentPickerPlugin from './plugins/ComponentPickerPlugin';
import ContextMenuPlugin from './plugins/ContextMenuPlugin';
import DraggableBlockPlugin from './plugins/DraggableBlockPlugin';
import EmojiPickerPlugin from './plugins/EmojiPickerPlugin';
import FloatingLinkEditorPlugin from './plugins/FloatingLinkEditorPlugin';
import FloatingTextFormatToolbarPlugin from './plugins/FloatingTextFormatToolbarPlugin';
import { MentionsPlugin } from './plugins/MentionsExtension';
import MarkdownPastePlugin from './plugins/MarkdownPastePlugin';
import FloatingRubyEditorPlugin from './plugins/RubyExtension/FloatingRubyEditor';
import { ShortcutsExtension } from './plugins/ShortcutsExtension';
import CodeFeaturesGate from './plugins/CodeFeaturesGate';
import TableClipboardPlugin from './plugins/TableClipboardPlugin';
import TableFeaturesGate from './plugins/TableFeaturesGate';
import ToolbarPlugin from './plugins/ToolbarPlugin';
import ContentEditable from './ui/ContentEditable';
import {useNotebookSession} from '../workspace/NotebookBridge';

export default function Editor(): JSX.Element {
  const {
    settings: {
      isCollab,
      isCharLimit,
      hasFitNestedTables,
      isCharLimitUtf8,
      isRichText,
      shouldUseLexicalContextMenu,
      shouldPreserveNewLinesInMarkdown,
    },
  } = useSettings();
  // Mirror the settings context onto the editor's reactive extension config
  // signals (NOT via App.tsx's DynamicSettings, which would rebuild the
  // editor). See the hook for details.
  useSynchronizeSettings();
  const placeholder = isCollab
    ? '一起创作，从这里开始…'
    : isRichText
      ? '写下你的想法，或输入 / 插入内容…'
      : '写下你的文字…';
  const [floatingAnchorElem, setFloatingAnchorElem] = useState<HTMLDivElement | null>(null);
  const [isSmallWidthViewport, setIsSmallWidthViewport] = useState<boolean>(false);
  const [editor] = useLexicalComposerContext();
  const notebookSession = useNotebookSession();
  const [activeEditor, setActiveEditor] = useState(editor);
  // The link edit mode state lives on the ShortcutsExtension output so the
  // insert-link keyboard shortcut can set it without any React coupling
  // (the extension is only present in rich text configurations)
  const isLinkEditModeSignal = useMemo(
    () =>
      isRichText ? getExtensionDependencyFromEditor(editor, ShortcutsExtension).output.isLinkEditMode : signal(false),
    [editor, isRichText],
  );
  const isLinkEditMode = useSignalValue(isLinkEditModeSignal);
  const setIsLinkEditMode = useCallback(
    (nextIsLinkEditMode: boolean) => {
      if (isRichText) {
        getExtensionDependencyFromEditor(editor, ShortcutsExtension).output.isLinkEditMode.value = nextIsLinkEditMode;
      }
    },
    [editor, isRichText],
  );
  const [isRubyEditMode, setIsRubyEditMode] = useState<boolean>(false);

  const onRef = (_floatingAnchorElem: HTMLDivElement) => {
    if (_floatingAnchorElem !== null) {
      setFloatingAnchorElem(_floatingAnchorElem);
    }
  };

  useEffect(() => {
    const updateViewPortWidth = () => {
      const isNextSmallWidthViewport = CAN_USE_DOM && window.matchMedia('(max-width: 1025px)').matches;

      if (isNextSmallWidthViewport !== isSmallWidthViewport) {
        setIsSmallWidthViewport(isNextSmallWidthViewport);
      }
    };
    updateViewPortWidth();
    return registerEventListener(window, 'resize', updateViewPortWidth);
  }, [isSmallWidthViewport]);

  return (
    <>
      {isRichText && (
        <ToolbarPlugin
          editor={editor}
          activeEditor={activeEditor}
          setActiveEditor={setActiveEditor}
          setIsLinkEditMode={setIsLinkEditMode}
          setIsRubyEditMode={setIsRubyEditMode}
        />
      )}
      <div className={`editor-container ${!isRichText ? 'plain-text' : ''}`}>
        <ComponentPickerPlugin />
        <EmojiPickerPlugin />
        <AutoEmbedPlugin />
        <MentionsPlugin />
        {isRichText ? (
          <>
            <div className="editor-scroller">
              <div className="editor" ref={onRef}>
                <ContentEditable placeholder={placeholder} />
              </div>
            </div>{' '}
            <MarkdownPastePlugin />
            <TableClipboardPlugin />
            <TableFeaturesGate hasFitNestedTables={hasFitNestedTables} />
            {floatingAnchorElem && (
              <>
                <CodeFeaturesGate anchorElem={floatingAnchorElem} />
                <FloatingLinkEditorPlugin
                  anchorElem={floatingAnchorElem}
                  isLinkEditMode={isLinkEditMode}
                  setIsLinkEditMode={setIsLinkEditMode}
                />
                <FloatingRubyEditorPlugin
                  anchorElem={floatingAnchorElem}
                  isRubyEditMode={isRubyEditMode}
                  setIsRubyEditMode={setIsRubyEditMode}
                />
              </>
            )}
            {floatingAnchorElem && !isSmallWidthViewport && (
              <>
                <DraggableBlockPlugin anchorElem={floatingAnchorElem} protectFirstBlock={Boolean(notebookSession)} />
                <FloatingTextFormatToolbarPlugin
                  anchorElem={floatingAnchorElem}
                  setIsLinkEditMode={setIsLinkEditMode}
                  isRubyEditMode={isRubyEditMode}
                />
              </>
            )}
          </>
        ) : (
          <ContentEditable placeholder={placeholder} />
        )}
        {(isCharLimit || isCharLimitUtf8) && (
          <CharacterLimitPlugin charset={isCharLimit ? 'UTF-16' : 'UTF-8'} maxLength={5} />
        )}
        {shouldUseLexicalContextMenu && (
          <ContextMenuPlugin shouldPreserveNewLinesInMarkdown={shouldPreserveNewLinesInMarkdown} />
        )}
      </div>
    </>
  );
}
