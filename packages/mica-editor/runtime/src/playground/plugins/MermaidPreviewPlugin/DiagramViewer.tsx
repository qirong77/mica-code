import { Button } from '@arco-design/web-react';
import { IconMinus, IconPlus, IconRefresh, IconFullscreen } from '@arco-design/web-react/icon';
import { type JSX, useCallback, useLayoutEffect, useRef, useState } from 'react';

import Modal from '../../ui/Modal';
import {
  clampTransform,
  type DiagramSize,
  type DiagramTransform,
  getFitTransform,
  zoomTransform,
} from './diagramViewport';

type Point = { x: number; y: number };

/** The inline SVG is unmounted while this viewer is open, keeping all SVG IDs
 * unique without re-running Mermaid or duplicating label/marker references. */
export default function DiagramViewer({
  svg,
  diagram,
  label,
  stale,
  onClose,
}: {
  svg: string;
  diagram: DiagramSize;
  label: string;
  stale: boolean;
  onClose: () => void;
}): JSX.Element {
  const viewportRef = useRef<HTMLDivElement>(null);
  const [viewport, setViewport] = useState<HTMLDivElement | null>(null);
  const attachViewport = useCallback((element: HTMLDivElement | null) => {
    viewportRef.current = element;
    setViewport(element);
  }, []);
  const sizeRef = useRef({ width: 1, height: 1 });
  const transformRef = useRef<DiagramTransform>({ scale: 1, x: 0, y: 0 });
  const [transform, setTransform] = useState(transformRef.current);
  const [dragging, setDragging] = useState(false);
  const fitMode = useRef(true);
  const pointers = useRef(new Map<number, Point>());
  const change = useCallback((next: DiagramTransform) => {
    transformRef.current = next;
    setTransform(next);
  }, []);
  const fit = useCallback(() => {
    fitMode.current = true;
    change(getFitTransform(diagram, sizeRef.current));
  }, [change, diagram]);
  const zoom = useCallback(
    (scale: number, point?: Point) => {
      fitMode.current = false;
      const viewport = sizeRef.current;
      change(
        zoomTransform(
          transformRef.current,
          scale,
          point || { x: viewport.width / 2, y: viewport.height / 2 },
          diagram,
          viewport,
        ),
      );
    },
    [change, diagram],
  );

  useLayoutEffect(() => {
    if (!viewport) return;
    const refresh = () => {
      if (!viewport.clientWidth || !viewport.clientHeight) return;
      sizeRef.current = { width: viewport.clientWidth, height: viewport.clientHeight };
      change(
        fitMode.current
          ? getFitTransform(diagram, sizeRef.current)
          : clampTransform(transformRef.current, diagram, sizeRef.current),
      );
    };
    const observer = new ResizeObserver(refresh);
    observer.observe(viewport);
    refresh();
    return () => observer.disconnect();
  }, [change, diagram, viewport]);

  useLayoutEffect(() => {
    if (!viewport) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const rect = viewport.getBoundingClientRect();
      const delta = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? viewport.clientHeight : 1);
      zoom(transformRef.current.scale * Math.exp(-Math.max(-100, Math.min(100, delta)) * 0.006), {
        x: event.clientX - rect.left,
        y: event.clientY - rect.top,
      });
    };
    viewport.addEventListener('wheel', onWheel, { passive: false });
    return () => viewport.removeEventListener('wheel', onWheel);
  }, [viewport, zoom]);

  const release = (pointerId: number) => {
    pointers.current.delete(pointerId);
    if (viewportRef.current?.hasPointerCapture(pointerId)) viewportRef.current.releasePointerCapture(pointerId);
    setDragging(pointers.current.size > 0);
  };

  return (
    <Modal
      title={`${label} · Mermaid`}
      onClose={onClose}
      closeOnClickOutside
      className="mermaid-viewer"
      style={{
        width: 'min(1180px, calc(100vw - 32px))',
        ...{ '--mermaid-viewer-aspect': diagram.width / diagram.height },
      }}
    >
      <div className="mermaid-viewer-toolbar" role="group" aria-label="图表缩放">
        <span className="mermaid-viewer-hint">{stale ? '上次成功的预览' : '拖动平移 · 滚轮缩放'}</span>
        <Button
          type="text"
          size="mini"
          htmlType="button"
          icon={<IconMinus />}
          aria-label="缩小图表"
          title="缩小（−）"
          disabled={transform.scale <= Math.min(0.1, getFitTransform(diagram, sizeRef.current).scale)}
          onClick={() => zoom(transformRef.current.scale / 1.25)}
        />
        <Button
          type="text"
          size="mini"
          htmlType="button"
          className="mermaid-viewer-scale"
          title="原始尺寸（1）"
          aria-label="图表原始尺寸"
          onClick={() => zoom(1)}
        >
          {transform.scale < 0.1 ? Math.round(transform.scale * 1000) / 10 : Math.round(transform.scale * 100)}%
        </Button>
        <Button
          type="text"
          size="mini"
          htmlType="button"
          icon={<IconPlus />}
          aria-label="放大图表"
          title="放大（+）"
          disabled={transform.scale >= 4}
          onClick={() => zoom(transformRef.current.scale * 1.25)}
        />
        <span className="mermaid-toolbar-divider" />
        <Button
          type="text"
          size="mini"
          htmlType="button"
          icon={<IconFullscreen />}
          aria-label="图表适应窗口"
          title="适应窗口（0）"
          onClick={fit}
        >
          适应
        </Button>
      </div>
      <div
        ref={attachViewport}
        className={`mermaid-viewer-viewport${dragging ? ' is-dragging' : ''}`}
        role="region"
        aria-label="图表画布，方向键平移，加减号缩放，0 适应窗口"
        tabIndex={0}
        onDoubleClick={fit}
        onKeyDown={(event) => {
          if (event.metaKey || event.ctrlKey || event.altKey) return;
          if (
            ['+', '=', '-', '_', '0', '1', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home'].includes(
              event.key,
            )
          )
            event.preventDefault();
          if (event.key === '+' || event.key === '=') zoom(transformRef.current.scale * 1.25);
          else if (event.key === '-' || event.key === '_') zoom(transformRef.current.scale / 1.25);
          else if (event.key === '0' || event.key === 'Home') fit();
          else if (event.key === '1') zoom(1);
          else if (event.key.startsWith('Arrow')) {
            fitMode.current = false;
            const offset = event.shiftKey ? 100 : 40;
            change(
              clampTransform(
                {
                  ...transformRef.current,
                  x:
                    transformRef.current.x +
                    (event.key === 'ArrowLeft' ? offset : event.key === 'ArrowRight' ? -offset : 0),
                  y:
                    transformRef.current.y +
                    (event.key === 'ArrowUp' ? offset : event.key === 'ArrowDown' ? -offset : 0),
                },
                diagram,
                sizeRef.current,
              ),
            );
          }
        }}
        onPointerDown={(event) => {
          if (event.button !== 0) return;
          event.preventDefault();
          event.currentTarget.focus({ preventScroll: true });
          event.currentTarget.setPointerCapture(event.pointerId);
          pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
          setDragging(true);
        }}
        onPointerMove={(event) => {
          const previous = pointers.current.get(event.pointerId);
          if (!previous) return;
          fitMode.current = false;
          const next = { x: event.clientX, y: event.clientY };
          const other = [...pointers.current].find(([id]) => id !== event.pointerId)?.[1];
          pointers.current.set(event.pointerId, next);
          if (other) {
            const before = { x: (previous.x + other.x) / 2, y: (previous.y + other.y) / 2 };
            const after = { x: (next.x + other.x) / 2, y: (next.y + other.y) / 2 };
            const oldDistance = Math.hypot(previous.x - other.x, previous.y - other.y);
            const newDistance = Math.hypot(next.x - other.x, next.y - other.y);
            const rect = event.currentTarget.getBoundingClientRect();
            const moved = {
              ...transformRef.current,
              x: transformRef.current.x + after.x - before.x,
              y: transformRef.current.y + after.y - before.y,
            };
            change(
              zoomTransform(
                moved,
                moved.scale * (oldDistance > 0 ? newDistance / oldDistance : 1),
                { x: after.x - rect.left, y: after.y - rect.top },
                diagram,
                sizeRef.current,
              ),
            );
          } else {
            change(
              clampTransform(
                {
                  ...transformRef.current,
                  x: transformRef.current.x + next.x - previous.x,
                  y: transformRef.current.y + next.y - previous.y,
                },
                diagram,
                sizeRef.current,
              ),
            );
          }
        }}
        onPointerUp={(event) => release(event.pointerId)}
        onPointerCancel={(event) => release(event.pointerId)}
        onLostPointerCapture={(event) => release(event.pointerId)}
        onBlur={() => {
          for (const id of pointers.current.keys()) release(id);
        }}
      >
        <div
          className="mermaid-viewer-graphic"
          style={{
            width: diagram.width,
            height: diagram.height,
            transform: `translate(${transform.x}px, ${transform.y}px) scale(${transform.scale})`,
          }}
          dangerouslySetInnerHTML={{ __html: svg }}
        />
      </div>
      <div className="mermaid-viewer-footer">
        <IconRefresh aria-hidden="true" /> 双击画布复位<span>Esc 关闭</span>
      </div>
    </Modal>
  );
}
