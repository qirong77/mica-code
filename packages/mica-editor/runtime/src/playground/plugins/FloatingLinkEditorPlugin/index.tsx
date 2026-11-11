/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import './index.css';

import {Button, Input} from '@arco-design/web-react';
import type {RefInputType} from '@arco-design/web-react/es/Input/interface';
import {autoUpdate, flip, inline, offset, shift, useFloating} from '@floating-ui/react';
import {$isAutoLinkNode, $isLinkNode} from '@lexical/link';
import {useLexicalComposerContext} from '@lexical/react/LexicalComposerContext';
import {
  $findMatchingParent,
  $getNearestNodeFromDOMNode,
  $getNodeByKey,
  $getSelection,
  $isDecoratorNode,
  $isNodeSelection,
  type BaseSelection,
  CLICK_COMMAND,
  COMMAND_PRIORITY_CRITICAL,
  COMMAND_PRIORITY_HIGH,
  getActiveElementDeep,
  getDOMSelection,
  getDOMSelectionRangeAndPoints,
  getParentElement,
  getRootOwnerDocument,
  KEY_ESCAPE_COMMAND,
  type LexicalEditor,
  mergeRegister,
  SELECTION_CHANGE_COMMAND,
} from 'lexical';
import * as React from 'react';
import {type Dispatch, type JSX, useCallback, useEffect, useId, useRef, useState} from 'react';
import {createPortal} from 'react-dom';
import {$isImageNode} from '../../nodes/ImageNode';

import {
  $applyLinkEdit,
  $createLinkEditSession,
  $removeLink,
  $restoreLinkSelection,
  type LinkEditSession,
  type LinkUrlStrategy,
  normalizeLinkUrl,
  registerLinkDraftRequests,
} from './linkEditing';

function FloatingLinkEditor({
  editor,
  anchorElem,
  isLinkEditMode,
  setIsLinkEditMode,
  markdownOnly,
}: {
  editor: LexicalEditor;
  anchorElem: HTMLElement;
  isLinkEditMode: boolean;
  setIsLinkEditMode: Dispatch<boolean>;
  markdownOnly: boolean;
}): JSX.Element {
  const urlStrategy: LinkUrlStrategy = markdownOnly ? 'markdown' : 'rich-text';
  const [activeEditor, setActiveEditor] = useState(editor);
  const popupRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<RefInputType>(null);
  const inputId = useId();
  const [target, setTarget] = useState<LinkEditSession | null>(null);
  const targetRef = useRef<LinkEditSession | null>(null);
  const draftRef = useRef<LinkEditSession | null>(null);
  const dismissedSelection = useRef<BaseSelection | null>(null);
  const [editedUrl, setEditedUrl] = useState('');
  const [error, setError] = useState<string | null>(null);
  const composing = useRef(false);
  const scrollerElem = getParentElement(anchorElem);

  const {refs, floatingStyles} = useFloating({
    middleware: [
      inline(),
      offset(10),
      flip({boundary: scrollerElem || undefined, padding: 10}),
      shift({boundary: scrollerElem || undefined, crossAxis: true, padding: 10}),
    ],
    placement: 'bottom-start',
    strategy: 'absolute',
    whileElementsMounted: (...args) => autoUpdate(...args, {ancestorScroll: false}),
  });

  const hide = useCallback(() => {
    targetRef.current = null;
    draftRef.current = null;
    setTarget(null);
    setError(null);
    setIsLinkEditMode(false);
  }, [setIsLinkEditMode]);

  const $positionAtSelection = useCallback(
    (session: LinkEditSession) => {
      const currentEditor = session.editor;
      const root = currentEditor.getRootElement();
      let referenceElement: HTMLElement | null = null;
      const link = session.linkKey ? $getNodeByKey(session.linkKey) : null;
      if ($isLinkNode(link)) {
        const onlyChild = link.getChildrenSize() === 1 ? link.getFirstChild() : null;
        referenceElement = currentEditor.getElementByKey(
          onlyChild && $isDecoratorNode(onlyChild) ? onlyChild.getKey() : link.getKey(),
        );
      } else if ($isNodeSelection(session.selection)) {
        const node = session.selection.getNodes()[0];
        referenceElement = node ? currentEditor.getElementByKey(node.getKey()) : null;
      }
      if (referenceElement) {
        const element = referenceElement;
        refs.setPositionReference({
          contextElement: element,
          getBoundingClientRect: () => element.getBoundingClientRect(),
          getClientRects: () => element.getClientRects(),
        });
      } else if (root) {
        const nativeSelection = getDOMSelection(currentEditor._window);
        if (nativeSelection && nativeSelection.rangeCount > 0) {
          const {points, range} = getDOMSelectionRangeAndPoints(nativeSelection, root);
          if (root.contains(points.anchorNode) && range) {
            // Keep an independent range when the input takes the DOM selection.
            refs.setPositionReference(range.cloneRange());
          }
        }
      }
    },
    [refs],
  );

  const beginEditing = useCallback(
    (session: LinkEditSession) => {
      dismissedSelection.current = null;
      targetRef.current = session;
      draftRef.current = session;
      setActiveEditor(session.editor);
      setTarget(session);
      // This is the only initialization of the draft. Editor update listeners
      // must never overwrite a URL while the user is typing it.
      setEditedUrl(session.url === 'https://' ? '' : session.url);
      setError(null);
      setIsLinkEditMode(true);
      session.editor.read('pending', () => $positionAtSelection(session));
    },
    [$positionAtSelection, setIsLinkEditMode],
  );

  const dismiss = useCallback(
    (restoreSelection: boolean) => {
      const session = draftRef.current ?? targetRef.current;
      if (!session) {
        return;
      }
      hide();
      if (restoreSelection) {
        session.editor.update(
          () => {
            $restoreLinkSelection(session);
            dismissedSelection.current = $getSelection()?.clone() ?? null;
          },
          {onUpdate: () => session.editor.focus()},
        );
      } else {
        session.editor.read('latest', () => {
          dismissedSelection.current = $getSelection()?.clone() ?? null;
        });
      }
    },
    [hide],
  );

  const $syncSelection = useCallback(() => {
    if (!activeEditor.isEditable()) {
      hide();
      return;
    }
    const root = activeEditor.getRootElement();
    const focused = getActiveElementDeep(getRootOwnerDocument(root));
    const session = draftRef.current ?? targetRef.current;
    if (session?.editor === activeEditor && (draftRef.current || popupRef.current?.contains(focused))) {
      $positionAtSelection(session);
      return;
    }
    const selection = $getSelection();
    // Images have their own toolbar. Only an explicit link-edit request should
    // open this form for them; passive previews would stack both toolbars.
    if ($isNodeSelection(selection) && selection.getNodes().some($isImageNode)) {
      hide();
      return;
    }
    if (dismissedSelection.current?.is(selection)) {
      return;
    }
    dismissedSelection.current = null;
    const next = $createLinkEditSession(activeEditor, urlStrategy);
    if (!next?.linkKey) {
      hide();
      return;
    }
    targetRef.current = next;
    setTarget(next);
    $positionAtSelection(next);
  }, [activeEditor, hide, $positionAtSelection, urlStrategy]);

  useEffect(
    () =>
      mergeRegister(
        editor.registerCommand(
          SELECTION_CHANGE_COMMAND,
          (_payload, originatingEditor) => {
            if (targetRef.current && targetRef.current.editor !== originatingEditor) {
              hide();
              dismissedSelection.current = null;
            }
            setActiveEditor(originatingEditor);
            return false;
          },
          COMMAND_PRIORITY_CRITICAL,
        ),
        registerLinkDraftRequests(editor, beginEditing, urlStrategy),
        editor.registerCommand(
          CLICK_COMMAND,
          (event, originatingEditor) => {
            if (!originatingEditor.isEditable() || popupRef.current?.contains(event.target as Node)) {
              return false;
            }
            const clickedLink = originatingEditor.read('pending', () => {
              const clicked = event.target instanceof Node ? $getNearestNodeFromDOMNode(event.target) : null;
              const link = clicked ? $findMatchingParent(clicked, $isLinkNode) : null;
              return !link || ($isAutoLinkNode(link) && link.getIsUnlinked())
                ? null
                : {key: link.getKey(), url: link.getURL()};
            });
            if (clickedLink === null) {
              return false;
            }
            // Editing must never navigate the page. Modifier-click is the explicit
            // shortcut for opening, and follows the same validation as the dialog.
            event.preventDefault();
            if (event.metaKey || event.ctrlKey) {
              const result = normalizeLinkUrl(clickedLink.url, urlStrategy);
              if (result.ok) {
                getRootOwnerDocument(originatingEditor.getRootElement()).defaultView?.open(
                  result.url,
                  '_blank',
                  'noopener,noreferrer',
                );
              }
              return true;
            }
            // Clicking the same caret position after Escape need not emit a new
            // selection change. Reopen its link without changing the selection.
            dismissedSelection.current = null;
            originatingEditor.read('pending', () => {
              const session = $createLinkEditSession(originatingEditor, urlStrategy);
              if (session?.linkKey === clickedLink.key) {
                targetRef.current = session;
                setActiveEditor(originatingEditor);
                setTarget(session);
                $positionAtSelection(session);
              }
            });
            return false;
          },
          COMMAND_PRIORITY_HIGH,
        ),
      ),
    [editor, beginEditing, hide, $positionAtSelection, urlStrategy],
  );

  useEffect(() => {
    activeEditor.read('latest', $syncSelection);
    return mergeRegister(
      activeEditor.registerUpdateListener(({editorState}) => editorState.read($syncSelection)),
      activeEditor.registerEditableListener((editable) => {
        if (!editable) hide();
      }),
      activeEditor.registerCommand(
        KEY_ESCAPE_COMMAND,
        (event) => {
          if (!targetRef.current) return false;
          event?.preventDefault();
          dismiss(true);
          return true;
        },
        COMMAND_PRIORITY_HIGH,
      ),
    );
  }, [activeEditor, $syncSelection, hide, dismiss]);

  // Also accept the existing external edit-mode flag when opening an already
  // selected link. Insertion requests are captured before any document change.
  useEffect(() => {
    if (isLinkEditMode && !draftRef.current) {
      const session = targetRef.current;
      if (session) beginEditing(session);
    }
  }, [isLinkEditMode, beginEditing]);

  useEffect(() => {
    if (isLinkEditMode && target && draftRef.current) {
      inputRef.current?.focus();
    }
  }, [isLinkEditMode, target]);

  useEffect(() => {
    if (!target) return;
    const doc = getRootOwnerDocument(activeEditor.getRootElement());
    const onPointerDown = (event: PointerEvent) => {
      if (popupRef.current?.contains(event.target as Node)) return;
      // A click in the editor begins a new selection. Let its update listener
      // resolve the next link after dropping the current draft.
      if (activeEditor.getRootElement()?.contains(event.target as Node)) {
        draftRef.current = null;
        dismissedSelection.current = null;
        setIsLinkEditMode(false);
      } else {
        dismiss(false);
      }
    };
    const onFocusIn = (event: FocusEvent) => {
      if (!popupRef.current?.contains(event.target as Node)) dismiss(false);
    };
    doc.addEventListener('pointerdown', onPointerDown, true);
    doc.addEventListener('focusin', onFocusIn);
    return () => {
      doc.removeEventListener('pointerdown', onPointerDown, true);
      doc.removeEventListener('focusin', onFocusIn);
    };
  }, [activeEditor, target, dismiss, setIsLinkEditMode]);

  const submit = () => {
    const session = draftRef.current;
    if (!session) return;
    let saved = false;
    session.editor.update(
      () => {
        const result = $applyLinkEdit(session, editedUrl, urlStrategy);
        if (!result.ok) {
          setError(result.error);
          return;
        }
        saved = true;
        dismissedSelection.current = $getSelection()?.clone() ?? null;
        hide();
      },
      {
        onUpdate: () => {
          if (saved) session.editor.focus();
          else inputRef.current?.focus();
        },
      },
    );
  };

  const remove = () => {
    const session = targetRef.current;
    if (!session) return;
    let removed = false;
    session.editor.update(
      () => {
        removed = $removeLink(session);
        if (removed) {
          dismissedSelection.current = $getSelection()?.clone() ?? null;
          hide();
        } else {
          setError('原来的链接已变化，请重新选择链接。');
        }
      },
      {
        onUpdate: () => {
          if (removed) session.editor.focus();
        },
      },
    );
  };

  const openLink = () => {
    if (!target) return;
    const result = normalizeLinkUrl(target.url, urlStrategy);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    getRootOwnerDocument(target.editor.getRootElement()).defaultView?.open(result.url, '_blank', 'noopener,noreferrer');
  };

  return createPortal(
    <div
      ref={(element) => {
        popupRef.current = element;
        refs.setFloating(element);
      }}
      className="link-editor mica-link-editor"
      role="dialog"
      aria-label={isLinkEditMode ? '编辑链接' : '链接'}
      hidden={!target}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && !composing.current && !event.nativeEvent.isComposing) {
          event.preventDefault();
          event.stopPropagation();
          dismiss(true);
        }
      }}
      style={floatingStyles}>
      {target &&
        (isLinkEditMode ? (
          <div className="mica-link-editor__form">
            <label className="mica-link-editor__label" htmlFor={inputId}>
              链接地址
            </label>
            <Input
              ref={inputRef}
              id={inputId}
              size="small"
              value={editedUrl}
              placeholder={markdownOnly ? 'https://example.com 或 ./README.md' : 'https://example.com'}
              autoComplete="off"
              spellCheck={false}
              aria-label="链接地址"
              aria-invalid={Boolean(error)}
              aria-describedby={`${inputId}-message`}
              status={error ? 'error' : undefined}
              onChange={(value) => {
                setEditedUrl(value);
                setError(null);
              }}
              onCompositionStart={() => {
                composing.current = true;
              }}
              onCompositionEnd={() => {
                composing.current = false;
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  if (!composing.current && !event.nativeEvent.isComposing && event.keyCode !== 229) submit();
                }
              }}
            />
            <p
              id={`${inputId}-message`}
              className={error ? 'mica-link-editor__error' : 'mica-link-editor__hint'}
              role={error ? 'alert' : undefined}>
              {error ?? (markdownOnly
                ? '支持网址、邮箱、电话、本地路径和 #锚点；空格请写为 %20。Enter 保存，Esc 取消。'
                : '支持网址、邮箱和电话；Enter 保存，Esc 取消。')}
            </p>
            <div className="mica-link-editor__actions">
              {target.linkKey && (
                <Button htmlType="button" type="text" size="mini" onClick={remove}>
                  移除链接
                </Button>
              )}
              <Button htmlType="button" size="mini" onClick={() => dismiss(true)}>
                取消
              </Button>
              <Button htmlType="button" type="primary" size="mini" onClick={submit}>
                保存链接
              </Button>
            </div>
          </div>
        ) : (
          <div className="mica-link-editor__preview">
            <Button
              htmlType="button"
              type="text"
              className="mica-link-editor__address"
              aria-label={`编辑链接地址：${target.url}`}
              title={target.url}
              onClick={() => beginEditing(target)}>
              {target.url || '编辑链接地址'}
            </Button>
            <div className="mica-link-editor__actions">
              <Button htmlType="button" type="text" size="mini" onClick={() => beginEditing(target)}>
                编辑链接
              </Button>
              <Button htmlType="button" type="text" size="mini" aria-label="在新窗口打开链接" onClick={openLink}>
                打开链接
              </Button>
              <Button htmlType="button" type="text" size="mini" onClick={remove}>
                移除链接
              </Button>
            </div>
            {error && (
              <p className="mica-link-editor__error" role="alert">
                {error}
              </p>
            )}
          </div>
        ))}
    </div>,
    anchorElem,
  );
}

export default function FloatingLinkEditorPlugin({
  anchorElem = document.body,
  isLinkEditMode,
  setIsLinkEditMode,
  markdownOnly = false,
}: {
  anchorElem?: HTMLElement;
  isLinkEditMode: boolean;
  setIsLinkEditMode: Dispatch<boolean>;
  markdownOnly?: boolean;
}): JSX.Element {
  const [editor] = useLexicalComposerContext();
  return (
    <FloatingLinkEditor
      editor={editor}
      anchorElem={anchorElem}
      isLinkEditMode={isLinkEditMode}
      setIsLinkEditMode={setIsLinkEditMode}
      markdownOnly={markdownOnly}
    />
  );
}
