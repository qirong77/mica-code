/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import './ImageNode.css';

import {Button} from '@arco-design/web-react';
import {IconDelete, IconExpand, IconImageClose} from '@arco-design/web-react/icon';
import {TOGGLE_LINK_COMMAND} from '@lexical/link';
import {useCollaborationContext} from '@lexical/react/LexicalCollaborationContext';
import {CollaborationPlugin} from '@lexical/react/LexicalCollaborationPlugin';
import {useLexicalComposerContext} from '@lexical/react/LexicalComposerContext';
import {LexicalExtensionEditorComposer} from '@lexical/react/LexicalExtensionEditorComposer';
import {useLexicalEditable} from '@lexical/react/useLexicalEditable';
import {useLexicalNodeSelection} from '@lexical/react/useLexicalNodeSelection';
import {
  $getNodeByKey,
  $getSelection,
  $isNodeSelection,
  $setSelection,
  CLICK_COMMAND,
  COMMAND_PRIORITY_LOW,
  createCommand,
  DRAGSTART_COMMAND,
  KEY_BACKSPACE_COMMAND,
  KEY_DELETE_COMMAND,
  KEY_ENTER_COMMAND,
  KEY_ESCAPE_COMMAND,
  type LexicalCommand,
  type LexicalEditorWithDispose,
  mergeRegister,
  type NodeKey,
} from 'lexical';
import {type JSX, Suspense, useCallback, useEffect, useRef, useState} from 'react';

import {useNotebookNestedEditor} from '../../workspace/NotebookBridge';
import {createWebsocketProvider, skipCollaborationInit} from '../collaboration';
import {useSettings} from '../context/SettingsContext';
import TreeViewPlugin from '../plugins/TreeViewPlugin';
import ImageCropDialog from '../ui/ImageCropDialog';
import ImageResizer from '../ui/ImageResizer';
import {
  type ImageAction,
  type ImageAlignment,
  ImageDescriptionDialog,
  ImagePreviewDialog,
  ImageSizeDialog,
  ImageToolbar,
} from '../ui/ImageTools';
import {imageContentWidth} from '../ui/imageResize';
import {type ImageTransformResult, rotateImage} from '../ui/imageTransform';
import {InsertImageDialog} from '../plugins/ImagesExtension';
import Modal from '../ui/Modal';
import {$imageBlock, $removeImage, $selectImage, updateImage} from './imageEditing';
import {$isImageNode} from './ImageNode';

type ImageStatus = {error: true} | {error: false; width: number; height: number};
const imageCache = new Map<string, Promise<ImageStatus> | ImageStatus>();

export const RIGHT_CLICK_IMAGE_COMMAND: LexicalCommand<MouseEvent> = createCommand(
  'RIGHT_CLICK_IMAGE_COMMAND',
);

function useSuspenseImage(src: string): ImageStatus {
  const cached = imageCache.get(src);
  if (cached && 'error' in cached) return cached;
  if (cached) throw cached;
  const pending = new Promise<ImageStatus>(resolve => {
    const image = new Image();
    image.onload = () =>
      resolve({error: false, width: image.naturalWidth, height: image.naturalHeight});
    image.onerror = () => resolve({error: true});
    image.src = src;
  }).then(result => {
    imageCache.set(src, result);
    return result;
  });
  imageCache.set(src, pending);
  throw pending;
}

type Props = {
  src: string;
  altText: string;
  nodeKey: NodeKey;
  width: 'inherit' | number;
  height: 'inherit' | number;
  maxWidth: number;
  resizable: boolean;
  showCaption: boolean;
  caption: LexicalEditorWithDispose;
  captionsEnabled: boolean;
};

export default function ImageComponent(props: Props): JSX.Element {
  return (
    <Suspense fallback={<span className="image-loading" aria-label="图片加载中" />}>
      <ImageEditor {...props} />
    </Suspense>
  );
}

function ImageEditor({
  src,
  altText,
  nodeKey,
  width,
  height,
  maxWidth,
  resizable,
  showCaption,
  caption,
  captionsEnabled,
}: Props) {
  const status = useSuspenseImage(src);
  useNotebookNestedEditor(caption);
  const [editor] = useLexicalComposerContext();
  const isEditable = useLexicalEditable();
  const {isCollabActive} = useCollaborationContext();
  const {
    settings: {showNestedEditorTreeView},
  } = useSettings();
  const [isSelected, setSelected, clearSelection] = useLexicalNodeSelection(nodeKey);
  const [isResizing, setIsResizing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dialog, setDialog] = useState<
    'size' | 'description' | 'crop' | 'replace' | 'preview' | null
  >(null);
  const [alignment, setAlignment] = useState<ImageAlignment>('left');
  const [singleSelection, setSingleSelection] = useState(false);
  const frameRef = useRef<HTMLDivElement>(null);
  const imageRef = useRef<HTMLImageElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const mounted = useRef(false);
  const previousDialog = useRef(dialog);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    if (!isEditable) {
      setDialog(null);
      setError(null);
    }
  }, [isEditable]);
  useEffect(() => {
    const closed = previousDialog.current !== null && dialog === null;
    previousDialog.current = dialog;
    if (closed) {
      // Modal releases its focus trap during unmount. Focus after that release,
      // including when the menu item that opened it no longer exists.
      queueMicrotask(() => {
        if (mounted.current && editor.isEditable())
          editor.getRootElement()?.focus({preventScroll: true});
      });
    }
  }, [dialog, editor]);

  const natural = status.error
    ? {width: 240, height: 160}
    : {width: status.width || maxWidth, height: status.height || maxWidth};
  const storedWidth = typeof width === 'number' && width > 0 ? width : natural.width;
  const storedHeight =
    typeof height === 'number' && height > 0
      ? height
      : (storedWidth * natural.height) / natural.width;
  const renderedWidth = Math.min(storedWidth, maxWidth);
  const renderedHeight = (renderedWidth * storedHeight) / storedWidth;
  const imageSize = () => {
    const frame = frameRef.current;
    return {
      width: frame?.offsetWidth || renderedWidth,
      height: frame?.offsetHeight || renderedHeight,
    };
  };
  const availableWidth = () =>
    imageContentWidth(
      frameRef.current?.closest<HTMLElement>('td, th, .PlaygroundEditorTheme__layoutItem') ??
        editor.getRootElement(),
    );
  const change = (update: Parameters<typeof updateImage>[2], expectedSrc?: string) =>
    updateImage(editor, nodeKey, update, expectedSrc);
  const setSize = (nextWidth: number, nextHeight: number) =>
    change(node => {
      node.setMaxWidth(Math.max(node.__maxWidth, nextWidth));
      node.setWidthAndHeight(Math.round(nextWidth), Math.round(nextHeight));
      $selectImage(node);
    });
  const restoreFocus = () => {
    setDialog(null);
  };
  const dismiss = useCallback(() => {
    editor.update(() => {
      const node = $getNodeByKey(nodeKey);
      if ($isImageNode(node)) $imageBlock(node)?.selectEnd();
    });
    editor.getRootElement()?.focus({preventScroll: true});
  }, [editor, nodeKey]);

  useEffect(() => {
    if (!isSelected) return;
    const sync = () =>
      editor.read('latest', () => {
        const node = $getNodeByKey(nodeKey);
        if (!$isImageNode(node)) return;
        const selection = $getSelection();
        setSingleSelection(
          $isNodeSelection(selection) &&
            selection.has(nodeKey) &&
            selection.getNodes().length === 1,
        );
        const format = $imageBlock(node)?.getFormatType();
        const next = format === 'center' || format === 'right' ? format : 'left';
        setAlignment(previous => (previous === next ? previous : next));
      });
    sync();
    return editor.registerUpdateListener(sync);
  }, [editor, isSelected, nodeKey]);

  const onClick = useCallback(
    (event: MouseEvent) => {
      if (
        event.target !== imageRef.current &&
        event.target !== frameRef.current &&
        !(
          event.target instanceof Element &&
          frameRef.current?.contains(event.target) &&
          event.target.closest('.image-broken')
        )
      )
        return false;
      if (!editor.isEditable()) return false;
      event.preventDefault();
      editor.getRootElement()?.focus({preventScroll: true});
      if (event.shiftKey) setSelected(!isSelected);
      else {
        clearSelection();
        setSelected(true);
      }
      setError(null);
      return true;
    },
    [editor, clearSelection, isSelected, setSelected],
  );

  useEffect(() => {
    const remove = (event: KeyboardEvent) => {
      const selection = $getSelection();
      if (!editor.isEditable() || !$isNodeSelection(selection) || !selection.has(nodeKey))
        return false;
      const target = event.target;
      if (
        target instanceof Element &&
        target.closest('input, textarea, button, [role="dialog"], .mica-menu')
      )
        return false;
      // The normal editor handler owns multi-image deletion.
      if (selection.getNodes().length !== 1) return false;
      event.preventDefault();
      const node = $getNodeByKey(nodeKey);
      if ($isImageNode(node)) $removeImage(node);
      return true;
    };
    return mergeRegister(
      editor.registerCommand(CLICK_COMMAND, onClick, COMMAND_PRIORITY_LOW),
      editor.registerCommand(RIGHT_CLICK_IMAGE_COMMAND, onClick, COMMAND_PRIORITY_LOW),
      editor.registerCommand(KEY_DELETE_COMMAND, remove, COMMAND_PRIORITY_LOW),
      editor.registerCommand(KEY_BACKSPACE_COMMAND, remove, COMMAND_PRIORITY_LOW),
      editor.registerCommand(
        KEY_ENTER_COMMAND,
        event => {
          const selection = $getSelection();
          if (
            !editor.isEditable() ||
            !$isNodeSelection(selection) ||
            !selection.has(nodeKey) ||
            selection.getNodes().length !== 1
          )
            return false;
          event?.preventDefault();
          if (showCaption) {
            $setSelection(null);
            caption.focus();
          } else buttonRef.current?.focus();
          return true;
        },
        COMMAND_PRIORITY_LOW,
      ),
      editor.registerCommand(
        KEY_ESCAPE_COMMAND,
        event => {
          const selection = $getSelection();
          if (!$isNodeSelection(selection) || !selection.has(nodeKey)) return false;
          event?.preventDefault();
          dismiss();
          return true;
        },
        COMMAND_PRIORITY_LOW,
      ),
      editor.registerCommand(
        DRAGSTART_COMMAND,
        event => {
          if (event.target !== imageRef.current) return false;
          event.preventDefault();
          return true;
        },
        COMMAND_PRIORITY_LOW,
      ),
    );
  }, [caption, dismiss, editor, nodeKey, onClick, showCaption]);

  const applyTransform = (result: ImageTransformResult, expectedSrc: string, rotate = false) => {
    if (!mounted.current) return false;
    const display = imageSize();
    const nextWidth = Math.min(
      rotate ? display.height : display.width,
      availableWidth(),
      result.width,
    );
    const applied = change(node => {
      node.setSrc(result.src);
      node.setMaxWidth(Math.max(node.__maxWidth, nextWidth));
      node.setWidthAndHeight(
        Math.round(nextWidth),
        Math.round((nextWidth * result.height) / result.width),
      );
      $selectImage(node);
    }, expectedSrc);
    if (!applied) setError('图片已变化，请重新选择后再试。');
    return applied;
  };
  const onAction = (action: ImageAction) => {
    if (!editor.isEditable()) return;
    setError(null);
    if (action === 'delete') {
      change($removeImage);
      editor.focus();
    } else if (action === 'link') {
      editor.update(() => {
        const node = $getNodeByKey(nodeKey);
        if ($isImageNode(node)) $selectImage(node);
      });
      editor.dispatchCommand(TOGGLE_LINK_COMMAND, 'https://');
    } else if (action === 'reset') {
      change(node => {
        node.setWidthAndHeight('inherit', 'inherit');
        $selectImage(node);
      });
    } else if (action === 'rotate') {
      setBusy(true);
      const originalSrc = src;
      rotateImage(src)
        .then(result => applyTransform(result, originalSrc, true))
        .catch(reason => {
          if (mounted.current)
            setError(reason instanceof Error ? reason.message : '旋转图片失败，请重试。');
        })
        .finally(() => {
          if (mounted.current) setBusy(false);
        });
    } else setDialog(action);
  };
  const showTools = isSelected && singleSelection && isEditable && !isResizing && !dialog;
  return (
    <>
      <div
        ref={frameRef}
        className={`image-frame${isSelected && isEditable ? ' is-selected' : ''}${isResizing ? ' is-resizing' : ''}${status.error ? ' is-broken' : ''}`}
        style={{
          width: renderedWidth,
          maxWidth: '100%',
          aspectRatio: `${storedWidth} / ${storedHeight}`,
        }}
        draggable={isSelected && isEditable && !isResizing}
        onDoubleClick={event => {
          if (!status.error && event.target === imageRef.current) {
            event.preventDefault();
            setDialog('preview');
          }
        }}
        onContextMenu={event => {
          if (isEditable) {
            clearSelection();
            setSelected(true);
          }
        }}>
        {status.error ? (
          <span className="image-broken">
            <IconImageClose />
            <span>图片加载失败</span>
            <span>{altText || '可在图片菜单中替换图片'}</span>
          </span>
        ) : (
          <img ref={imageRef} src={src} alt={altText} draggable={false} />
        )}
        {isSelected && singleSelection && isEditable && !status.error && !isResizing && !busy && (
          <div className="image-quick-actions" onMouseDown={event => event.preventDefault()}>
            <Button
              type="text"
              size="mini"
              icon={<IconExpand />}
              aria-label="预览图片"
              title="预览图片"
              onClick={() => onAction('preview')}
            />
            <Button
              type="text"
              size="mini"
              icon={<IconDelete />}
              aria-label="删除图片"
              title="删除图片"
              onClick={() => onAction('delete')}
            />
          </div>
        )}
        {resizable &&
          isSelected &&
          singleSelection &&
          isEditable &&
          !status.error &&
          !dialog &&
          !busy && (
            <ImageResizer
              editor={editor}
              buttonRef={buttonRef}
              imageRef={frameRef}
              maxWidth={availableWidth()}
              captionsEnabled={false}
              showCaption={showCaption}
              setShowCaption={() => {}}
              lockAspectRatio
              showSideHandles={false}
              onResizeStart={() => setIsResizing(true)}
              onResizeCancel={() => {if (mounted.current) setIsResizing(false);}}
              onResizeEnd={(nextWidth, nextHeight) => {
                frameRef.current?.style.removeProperty('height');
                if (typeof nextWidth === 'number' && typeof nextHeight === 'number')
                  setSize(nextWidth, nextHeight);
                setIsResizing(false);
              }}
            />
          )}
      </div>
      {showCaption && (
        <div
          className="image-caption-container"
          onKeyDown={event => {
            if (event.key === 'Escape') {
              event.preventDefault();
              event.stopPropagation();
              change($selectImage);
              editor.focus();
            }
          }}>
          <LexicalExtensionEditorComposer initialEditor={caption}>
            {isCollabActive && (
              <CollaborationPlugin
                id={caption.getKey()}
                providerFactory={createWebsocketProvider}
                shouldBootstrap={!skipCollaborationInit}
                selectionHighlight
              />
            )}
            {showNestedEditorTreeView && <TreeViewPlugin />}
          </LexicalExtensionEditorComposer>
        </div>
      )}
      {showTools && (
        <ImageToolbar
          anchor={frameRef}
          buttonRef={buttonRef}
          alignment={alignment}
          showCaption={showCaption}
          captionsEnabled={captionsEnabled}
          busy={busy}
          broken={status.error}
          onAction={onAction}
          onDismiss={dismiss}
          onAlign={value =>
            change(node => {
              $imageBlock(node)?.setFormat(value);
              $selectImage(node);
            })
          }
        />
      )}
      {error && isSelected && (
        <div className="image-operation-error" role="alert">
          {error}
        </div>
      )}
      {dialog === 'preview' && (
        <ImagePreviewDialog src={src} altText={altText} onClose={restoreFocus} />
      )}
      {isEditable && dialog === 'size' && (
        <ImageSizeDialog
          {...imageSize()}
          maxWidth={availableWidth()}
          onApply={setSize}
          onClose={restoreFocus}
        />
      )}
      {isEditable && dialog === 'description' && (
        <ImageDescriptionDialog
          altText={altText}
          showCaption={showCaption}
          captionsEnabled={captionsEnabled}
          onApply={(description, visible) => {
            change(node => {
              node.setAltText(description);
              node.setShowCaption(visible);
              $selectImage(node);
            });
          }}
          onClose={restoreFocus}
        />
      )}
      {isEditable && dialog === 'crop' && (
        <ImageCropDialog
          src={src}
          altText={altText}
          onApply={result => applyTransform(result, src)}
          onClose={restoreFocus}
        />
      )}
      {isEditable && dialog === 'replace' && (
        <Modal title="替换图片" onClose={restoreFocus} className="image-settings-modal">
          <InsertImageDialog
            activeEditor={editor}
            onClose={restoreFocus}
            onInsert={payload => {
              change(node => {
                node.setSrc(payload.src);
                node.setAltText(payload.altText || altText);
                node.setWidthAndHeight(Math.round(imageSize().width), 'inherit');
                $selectImage(node);
              }, src);
            }}
          />
        </Modal>
      )}
    </>
  );
}
