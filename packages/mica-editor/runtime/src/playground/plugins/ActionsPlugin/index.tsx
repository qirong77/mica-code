/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {$createCodeNode, $isCodeNode, CodeIndentExtension} from '@lexical/code';
import {getPeerDependencyFromEditor} from '@lexical/extension';
import {
  exportFile,
  importFile,
} from '@lexical/file';
import {
  $generateHtmlFromNodes,
  $generateNodesFromDOMViaExtension,
  $withRenderContext,
  contextValue,
} from '@lexical/html';
import {
  $convertFromMarkdownString,
  $convertToMarkdownString,
} from '@lexical/markdown';
import {useCollaborationContext} from '@lexical/react/LexicalCollaborationContext';
import {useLexicalComposerContext} from '@lexical/react/LexicalComposerContext';
import {CONNECTED_COMMAND, TOGGLE_CONNECT_COMMAND} from '@lexical/yjs';
import {
  $createParagraphNode,
  $getRoot,
  $insertNodes,
  $isParagraphNode,
  CLEAR_EDITOR_COMMAND,
  COMMAND_PRIORITY_EDITOR,
  type LexicalEditor,
  mergeRegister,
  RootNode,
} from 'lexical';
import {
  type JSX,
  startTransition,
  useActionState,
  useEffect,
  useOptimistic,
  useRef,
  useState,
} from 'react';

import useModal from '../../hooks/useModal';
import Button from '../../ui/Button';
import {formatCodeWithPrettier} from '../CodeActionMenuPlugin/formatCodeWithPrettier';
import {PLAYGROUND_TRANSFORMERS} from '../MarkdownTransformers';
import {PagesExtension} from '../PagesExtension';
import ShortcutsHelpDialog from '../ShortcutsExtension/ShortcutsHelpDialog';
import {
  SPEECH_TO_TEXT_COMMAND,
  SUPPORT_SPEECH_RECOGNITION,
} from '../SpeechToTextPlugin';
import {RenderContextTerse} from '../TerseExportExtension';
import {SHOW_VERSIONS_COMMAND} from '../VersionsPlugin';

type EditorMode = 'wysiwyg' | 'markdown' | 'html';

export default function ActionsPlugin({
  shouldPreserveNewLinesInMarkdown,
  useCollabV2,
}: {
  shouldPreserveNewLinesInMarkdown: boolean;
  useCollabV2: boolean;
}): JSX.Element {
  const [editor] = useLexicalComposerContext();
  const [isEditable, setIsEditable] = useState(() => editor.isEditable());
  const [isSpeechToText, setIsSpeechToText] = useState(false);
  const [connected, setConnected] = useState(false);
  const [isEditorEmpty, setIsEditorEmpty] = useState(true);
  const [modal, showModal] = useModal();
  const {isCollabActive} = useCollaborationContext();
  const unregisterTransformRef = useRef(() => {});
  const [mode, dispatchMode, isPending] = useActionState(
    async (prevMode: EditorMode, nextMode: EditorMode): Promise<EditorMode> => {
      const pagesDisabled = getPeerDependencyFromEditor<typeof PagesExtension>(
        editor,
        PagesExtension.name,
      )?.output.disabled;
      if (pagesDisabled !== undefined) {
        pagesDisabled.value = true;
      }
      if (prevMode === 'wysiwyg') {
        // handle transitions from wysiwyg -> nextMode -> wysiwyg when there's a single
        // root child CodeNode that is the nextMode language. e2e tests assume you can
        // do this.
        editor.read(() => {
          const root = $getRoot();
          const codeNode =
            root.getChildrenSize() === 1
              ? root.getChildren().find($isCodeNode)
              : null;
          if (codeNode) {
            const language = codeNode.getLanguage();
            if (language === nextMode) {
              prevMode = nextMode;
              nextMode = 'wysiwyg';
            }
          }
        });
      }
      if (nextMode === 'wysiwyg') {
        unregisterTransformRef.current();
        editor.update(() => {
          if (prevMode === 'html') {
            const root = $getRoot();
            const parser = new DOMParser();
            const content = root.getTextContent();
            const dom = parser.parseFromString(content, 'text/html');
            const nodes = $generateNodesFromDOMViaExtension(dom);
            root.clear().select();
            $insertNodes(nodes);
            if (root.isEmpty()) {
              root.append($createParagraphNode()).select();
            }
          } else if (prevMode === 'markdown') {
            const root = $getRoot();
            const firstChild = root.getFirstChild();
            if (
              $isCodeNode(firstChild) &&
              firstChild.getLanguage() === 'markdown'
            ) {
              unregisterTransformRef.current();
              $convertFromMarkdownString(
                firstChild.getTextContent(),
                PLAYGROUND_TRANSFORMERS,
                undefined, // node
                shouldPreserveNewLinesInMarkdown,
              );
            }
          }
        });
      } else if (nextMode === 'markdown') {
        editor.update(() => {
          const markdown = $convertToMarkdownString(
            PLAYGROUND_TRANSFORMERS,
            undefined, //node
            shouldPreserveNewLinesInMarkdown,
          );
          const codeNode = $createCodeNode('markdown');
          $getRoot().clear().append(codeNode);
          codeNode.select().insertRawText(markdown);
          codeNode.select(0, 0);
        });
      } else if (nextMode === 'html') {
        const rawHtml = editor.read(() =>
          $withRenderContext(
            [contextValue(RenderContextTerse, true)],
            editor,
          )(() => $generateHtmlFromNodes(editor)),
        );
        const html = await formatCodeWithPrettier(rawHtml, 'html');
        editor.update(() => {
          const codeNode = $createCodeNode('html');
          $getRoot().clear().append(codeNode);
          codeNode.select().insertRawText(html.trimEnd());
          codeNode.select(0, 0);
        });
      }
      return nextMode;
    },
    'wysiwyg',
  );
  const [optimisticMode, setOptimisticMode] = useOptimistic<EditorMode>(mode);
  const isMarkdown = optimisticMode === 'markdown';
  const isHtml = optimisticMode === 'html';

  useEffect(() => {
    editor.getRootElement()?.removeAttribute('data-source-pending');
    editor.getRootElement()?.setAttribute('data-source-mode', mode);
    window.dispatchEvent(new CustomEvent('arco-editor-source-mode', {detail: mode}));
    const pagesDisabled = getPeerDependencyFromEditor<typeof PagesExtension>(
      editor,
      PagesExtension.name,
    )?.output.disabled;
    const escapeWithArrows = getPeerDependencyFromEditor<
      typeof CodeIndentExtension
    >(editor, CodeIndentExtension.name)?.output.escapeWithArrows;
    const isCodeBlockEditor = mode !== 'wysiwyg';
    if (pagesDisabled !== undefined) {
      pagesDisabled.value = isCodeBlockEditor;
    }
    if (escapeWithArrows !== undefined) {
      escapeWithArrows.value = !isCodeBlockEditor;
    }

    if (isCodeBlockEditor) {
      const unregister = editor.registerNodeTransform(RootNode, rootNode => {
        let codeNode = rootNode.getChildren().find($isCodeNode);
        if (!codeNode) {
          codeNode = $createCodeNode(mode);
        }
        if (rootNode.getChildrenSize() !== 1 || !codeNode.getParent()) {
          rootNode.splice(0, rootNode.getChildrenSize(), [codeNode]);
          codeNode.select();
        }
        if (codeNode.getLanguage() !== mode) {
          codeNode.setLanguage(mode);
        }
      });
      unregisterTransformRef.current = unregister;
      return unregister;
    }
  }, [editor, mode]);
  useEffect(() => {
    return mergeRegister(
      editor.registerEditableListener(editable => {
        setIsEditable(editable);
      }),
      editor.registerCommand(
        CONNECTED_COMMAND,
        payload => {
          const isConnected = payload;
          setConnected(isConnected);
          return false;
        },
        COMMAND_PRIORITY_EDITOR,
      ),
    );
  }, [editor]);

  useEffect(() => {
    return editor.registerUpdateListener(() => {
      editor.read('latest', () => {
        const root = $getRoot();
        const children = root.getChildren();

        if (children.length > 1) {
          setIsEditorEmpty(false);
        } else {
          if ($isParagraphNode(children[0])) {
            const paragraphChildren = children[0].getChildren();
            setIsEditorEmpty(paragraphChildren.length === 0);
          } else {
            setIsEditorEmpty(false);
          }
        }
      });
    });
  }, [editor]);

  const toggleMode = (targetMode: 'html' | 'markdown') => {
    startTransition(() => {
      const nextMode =
        mode === 'wysiwyg'
          ? targetMode
          : mode === targetMode
            ? 'wysiwyg'
            : mode;
      if (mode === nextMode) {
        return;
      }
      editor.getRootElement()?.setAttribute('data-source-pending', 'true');
      // Do not advertise wysiwyg until the conversion has actually committed.
      if (nextMode !== 'wysiwyg') editor.getRootElement()?.setAttribute('data-source-mode', nextMode);
      if (nextMode !== 'wysiwyg') {
        window.dispatchEvent(new CustomEvent('arco-editor-source-mode', {detail: nextMode}));
      }
      setOptimisticMode(nextMode);
      dispatchMode(nextMode);
    });
  };

  return (
    <div className="actions">
      <button
        className="action-button"
        title="快捷键"
        aria-label="查看快捷键"
        onClick={() =>
          showModal('快捷键', () => <ShortcutsHelpDialog />)
        }>
        <i className="keyboard-shortcuts" />
      </button>

      {SUPPORT_SPEECH_RECOGNITION && (
        <button
          onClick={() => {
            editor.dispatchCommand(SPEECH_TO_TEXT_COMMAND, !isSpeechToText);
            setIsSpeechToText(!isSpeechToText);
          }}
          className={
            'action-button action-button-mic ' +
            (isSpeechToText ? 'active' : '')
          }
          title="语音输入"
          aria-label={isSpeechToText ? '停止语音输入' : '开始语音输入'}>
          <i className="mic" />
        </button>
      )}
      <button
        className="action-button import"
        disabled={mode !== 'wysiwyg' || isPending}
        onClick={() => importFile(editor)}
        title="导入 JSON"
        aria-label="导入 JSON 文档">
        <i className="import" />
      </button>

      <button
        className="action-button export"
        disabled={mode !== 'wysiwyg' || isPending}
        onClick={() =>
          exportFile(editor, {
            fileName: `Notebook ${new Date().toISOString()}`,
            source: 'Playground',
          })
        }
        title="导出 JSON"
        aria-label="导出 JSON 文档">
        <i className="export" />
      </button>
      <button
        className="action-button clear"
        disabled={isEditorEmpty}
        onClick={() => {
          showModal('清空文档', onClose => (
            <ShowClearDialog editor={editor} onClose={onClose} />
          ));
        }}
        title="清空文档"
        aria-label="清空文档">
        <i className="clear" />
      </button>
      <button
        className={`action-button ${!isEditable ? 'unlock' : 'lock'}`}
        onClick={() => {
          editor.setEditable(!editor.isEditable());
        }}
        title="只读模式"
        aria-label={!isEditable ? '退出只读' : '设为只读'}>
        <i className={!isEditable ? 'unlock' : 'lock'} />
      </button>
      <button
        className="action-button"
        data-active={isMarkdown}
        disabled={isHtml || isPending}
        onClick={() => toggleMode('markdown')}
        title={isMarkdown ? '返回富文本' : 'Markdown 源码'}
        aria-label={
          isMarkdown ? '返回富文本' : 'Markdown 源码'
        }>
        <i className="markdown" />
      </button>
      <button
        className="action-button"
        data-active={isHtml}
        disabled={isMarkdown || isPending}
        onClick={() => toggleMode('html')}
        title={isHtml ? '返回富文本' : 'HTML 源码'}
        aria-label={isHtml ? '返回富文本' : 'HTML 源码'}>
        <i className="html" />
      </button>
      {isCollabActive && (
        <>
          <button
            className="action-button connect"
            onClick={() => {
              editor.dispatchCommand(TOGGLE_CONNECT_COMMAND, !connected);
            }}
            title={`${
              connected ? 'Disconnect' : 'Connect'
            } Collaborative Editing`}
            aria-label={`${
              connected ? 'Disconnect from' : 'Connect to'
            } a collaborative editing server`}>
            <i className={connected ? 'disconnect' : 'connect'} />
          </button>
          {useCollabV2 && (
            <button
              className="action-button versions"
              onClick={() => {
                editor.dispatchCommand(SHOW_VERSIONS_COMMAND);
              }}>
              <i className="versions" />
            </button>
          )}
        </>
      )}
      {modal}
    </div>
  );
}

function ShowClearDialog({
  editor,
  onClose,
}: {
  editor: LexicalEditor;
  onClose: () => void;
}): JSX.Element {
  return (
    <>
      确定清空正文吗？清空后可以使用撤销恢复。
      <div className="Modal__content">
        <Button
          onClick={() => {
            editor.dispatchCommand(CLEAR_EDITOR_COMMAND);
            editor.focus();
            onClose();
          }}>
          清空
        </Button>{' '}
        <Button
          onClick={() => {
            editor.focus();
            onClose();
          }}>
          取消
        </Button>
      </div>
    </>
  );
}
