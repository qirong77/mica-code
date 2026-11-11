/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {calculateZoomLevel} from '@lexical/utils';
import {type LexicalEditor} from 'lexical';
import * as React from 'react';
import {type JSX, useEffect, useRef, useState} from 'react';

import {imageContentWidth, type ImageSize, resizeImage} from './imageResize';

const HANDLES = [
  {direction: 'n', label: '调整图片上边尺寸'},
  {direction: 'ne', label: '调整图片右上角尺寸'},
  {direction: 'e', label: '调整图片右边尺寸'},
  {direction: 'se', label: '调整图片右下角尺寸'},
  {direction: 's', label: '调整图片下边尺寸'},
  {direction: 'sw', label: '调整图片左下角尺寸'},
  {direction: 'w', label: '调整图片左边尺寸'},
  {direction: 'nw', label: '调整图片左上角尺寸'},
];

type StyleValue = {value: string; priority: string};
type StyleLease = {original: StyleValue; values: StyleValue[]};

// A document can contain several editors. Releasing one drag must not reset
// another editor's cursor or selection suppression, even with two touch inputs.
const styleLeases = new WeakMap<CSSStyleDeclaration, Map<string, StyleLease>>();

function readStyle(style: CSSStyleDeclaration, property: string): StyleValue {
  return {
    priority: style.getPropertyPriority(property),
    value: style.getPropertyValue(property),
  };
}

function restoreStyle(
  style: CSSStyleDeclaration,
  property: string,
  previous: StyleValue,
): void {
  if (previous.value === '') {
    style.removeProperty(property);
  } else {
    style.setProperty(property, previous.value, previous.priority);
  }
}

function temporaryStyle(
  style: CSSStyleDeclaration | undefined,
  property: string,
  value: string,
): () => void {
  if (!style) {
    return () => {};
  }
  let properties = styleLeases.get(style);
  if (!properties) {
    properties = new Map();
    styleLeases.set(style, properties);
  }
  let lease = properties.get(property);
  if (!lease) {
    lease = {original: readStyle(style, property), values: []};
    properties.set(property, lease);
  }
  const entry = {priority: 'important', value};
  lease.values.push(entry);
  style.setProperty(property, entry.value, entry.priority);
  return () => {
    const index = lease.values.indexOf(entry);
    if (index === -1) {
      return;
    }
    const wasLast = index === lease.values.length - 1;
    lease.values.splice(index, 1);
    const current = readStyle(style, property);
    if (
      wasLast &&
      current.value === entry.value &&
      current.priority === entry.priority
    ) {
      restoreStyle(
        style,
        property,
        lease.values[lease.values.length - 1] ?? lease.original,
      );
    }
    if (lease.values.length === 0) {
      properties.delete(property);
      if (properties.size === 0) {
        styleLeases.delete(style);
      }
    }
  };
}

function imageZoom(image: HTMLElement): number {
  const zoom = calculateZoomLevel(image, true);
  return Number.isFinite(zoom) && zoom > 0 ? zoom : 1;
}

function displayedSize(image: HTMLElement, zoom: number): ImageSize {
  const rect = image.getBoundingClientRect();
  return {height: rect.height / zoom, width: rect.width / zoom};
}

function applySize(image: HTMLElement, size: ImageSize): void {
  image.style.width = `${size.width}px`;
  image.style.height = `${size.height}px`;
}

function cursorFor(direction: string): string {
  if (direction.length === 1) {
    return direction === 'e' || direction === 'w' ? 'ew-resize' : 'ns-resize';
  }
  return direction === 'nw' || direction === 'se' ? 'nwse-resize' : 'nesw-resize';
}

function stopHandleClick(event: React.MouseEvent<HTMLDivElement>): void {
  event.preventDefault();
  event.stopPropagation();
}

export default function ImageResizer({
  onResizeStart,
  onResizeEnd,
  onResizeCancel,
  buttonRef,
  imageRef,
  maxWidth,
  editor,
  showCaption,
  setShowCaption,
  captionsEnabled,
  lockAspectRatio = false,
  showSideHandles = true,
}: {
  editor: LexicalEditor;
  buttonRef: {current: null | HTMLButtonElement};
  imageRef: {current: null | HTMLElement};
  maxWidth?: number;
  onResizeEnd: (width: 'inherit' | number, height: 'inherit' | number) => void;
  onResizeStart: () => void;
  onResizeCancel?: () => void;
  setShowCaption: (show: boolean) => void;
  showCaption: boolean;
  captionsEnabled: boolean;
  lockAspectRatio?: boolean;
  showSideHandles?: boolean;
}): JSX.Element {
  const controlWrapperRef = useRef<HTMLDivElement>(null);
  const resizeCleanupRef = useRef<(() => void) | null>(null);
  const [isEditable, setIsEditable] = useState(() => editor.isEditable());
  useEffect(() => {
    setIsEditable(editor.isEditable());
    const unregister = editor.registerEditableListener(editable => {
      setIsEditable(editable);
      if (!editable) {
        resizeCleanupRef.current?.();
      }
    });
    return () => {
      unregister();
      resizeCleanupRef.current?.();
    };
  }, [editor]);

  const availableWidth = (image: HTMLElement) => {
    const root = editor.getRootElement();
    const rootZoom = root ? imageZoom(root) : imageZoom(image);
    // Usually the two zooms are equal; this also covers a locally zoomed image.
    const contentWidth =
      (imageContentWidth(root, root ? undefined : maxWidth) * rootZoom) /
      imageZoom(image);
    return Math.min(
      contentWidth,
      maxWidth !== undefined && Number.isFinite(maxWidth) && maxWidth >= 0
        ? maxWidth
        : Infinity,
    );
  };

  const handlePointerDown = (
    event: React.PointerEvent<HTMLDivElement>,
    direction: string,
  ) => {
    if (!editor.isEditable() || event.button !== 0 || !event.isPrimary) {
      return;
    }
    const image = imageRef.current;
    const controlWrapper = controlWrapperRef.current;
    if (image === null || controlWrapper === null || availableWidth(image) < 1) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    resizeCleanupRef.current?.();

    const target = event.currentTarget;
    const pointerId = event.pointerId;
    const zoom = imageZoom(image);
    const startSize = displayedSize(image, zoom);
    const startX = event.clientX;
    const startY = event.clientY;
    const originalWidth = readStyle(image.style, 'width');
    const originalHeight = readStyle(image.style, 'height');
    const doc = image.ownerDocument;
    const win = doc.defaultView;
    const cursor = cursorFor(direction);
    const restoreStyles = [
      temporaryStyle(editor.getRootElement()?.style, 'cursor', cursor),
      temporaryStyle(doc.body?.style, 'cursor', cursor),
      temporaryStyle(doc.body?.style, 'user-select', 'none'),
      temporaryStyle(doc.body?.style, '-webkit-user-select', 'none'),
    ];
    let active = true;
    let currentSize = startSize;

    const finish = (commit: boolean) => {
      if (!active) {
        return;
      }
      active = false;
      doc.removeEventListener('pointermove', move, true);
      doc.removeEventListener('pointerup', up, true);
      doc.removeEventListener('pointercancel', cancelPointer, true);
      target.removeEventListener('lostpointercapture', cancelPointer);
      win?.removeEventListener('blur', cancel);
      resizeCleanupRef.current = null;
      controlWrapper.classList.remove('image-control-wrapper--resizing');
      for (const restore of restoreStyles.reverse()) {
        restore();
      }
      if (target.hasPointerCapture?.(pointerId)) {
        target.releasePointerCapture(pointerId);
      }
      if (commit && editor.isEditable() && imageRef.current === image) {
        onResizeEnd(currentSize.width, currentSize.height);
      } else {
        restoreStyle(image.style, 'width', originalWidth);
        restoreStyle(image.style, 'height', originalHeight);
        onResizeCancel?.();
      }
    };
    const cancel = () => finish(false);
    const cancelPointer = (pointer: PointerEvent) => {
      if (pointer.pointerId === pointerId) {
        cancel();
      }
    };
    const move = (pointer: PointerEvent) => {
      if (pointer.pointerId !== pointerId || !active) {
        return;
      }
      if (
        !editor.isEditable() ||
        imageRef.current !== image ||
        !image.isConnected
      ) {
        cancel();
        return;
      }
      const widthLimit = availableWidth(image);
      if (widthLimit < 1) {
        cancel();
        return;
      }
      pointer.preventDefault();
      currentSize = resizeImage(
        startSize,
        {
          x: (pointer.clientX - startX) / zoom,
          y: (pointer.clientY - startY) / zoom,
        },
        direction,
        widthLimit,
        lockAspectRatio,
      );
      applySize(image, currentSize);
    };
    const up = (pointer: PointerEvent) => {
      if (pointer.pointerId === pointerId) {
        move(pointer);
        finish(true);
      }
    };

    resizeCleanupRef.current = cancel;
    doc.addEventListener('pointermove', move, {capture: true, passive: false});
    doc.addEventListener('pointerup', up, true);
    doc.addEventListener('pointercancel', cancelPointer, true);
    target.addEventListener('lostpointercapture', cancelPointer);
    win?.addEventListener('blur', cancel);
    // Document listeners also cover environments without pointer capture.
    try {
      target.setPointerCapture?.(pointerId);
    } catch {
      // A pointer may already have been released before capture is established.
    }
    controlWrapper.classList.add('image-control-wrapper--resizing');
    applySize(image, startSize);
    onResizeStart();
    if (!editor.isEditable()) {
      cancel();
    }
  };

  const handleKeyDown = (
    event: React.KeyboardEvent<HTMLDivElement>,
    direction: string,
  ) => {
    if (
      !editor.isEditable() ||
      resizeCleanupRef.current !== null ||
      event.altKey ||
      event.ctrlKey ||
      event.metaKey
    ) {
      return;
    }
    const step = event.shiftKey ? 10 : 1;
    const delta = {
      x: event.key === 'ArrowLeft' ? -step : event.key === 'ArrowRight' ? step : 0,
      y: event.key === 'ArrowUp' ? -step : event.key === 'ArrowDown' ? step : 0,
    };
    if (
      (!delta.x || !/[ew]/.test(direction)) &&
      (!delta.y || !/[ns]/.test(direction))
    ) {
      return;
    }
    const image = imageRef.current;
    if (image === null || availableWidth(image) < 1) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    const size = displayedSize(image, imageZoom(image));
    const next = resizeImage(
      size,
      delta,
      direction,
      availableWidth(image),
      lockAspectRatio,
    );
    if (next.width === size.width && next.height === size.height) {
      return;
    }
    onResizeStart();
    if (editor.isEditable() && imageRef.current === image && image.isConnected) {
      applySize(image, next);
      onResizeEnd(next.width, next.height);
    }
  };

  return (
    <div ref={controlWrapperRef}>
      {!showCaption && captionsEnabled && (
        <button
          type="button"
          disabled={!isEditable}
          className="image-caption-button"
          ref={buttonRef}
          onClick={() => {
            setShowCaption(!showCaption);
          }}>
          Add Caption
        </button>
      )}
      {HANDLES.filter(handle => showSideHandles || handle.direction.length === 2).map(
        ({direction, label}) => (
          <div
            key={direction}
            className={`image-resizer image-resizer-${direction}`}
            role="button"
            tabIndex={isEditable ? 0 : -1}
            aria-label={label}
            aria-disabled={!isEditable}
            style={{touchAction: 'none'}}
            onClick={stopHandleClick}
            onPointerDown={event => handlePointerDown(event, direction)}
            onKeyDown={event => handleKeyDown(event, direction)}
          />
        ),
      )}
    </div>
  );
}
