/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */
import {autoUpdate} from '@floating-ui/react';
import {useLexicalComposerContext} from '@lexical/react/LexicalComposerContext';
import {useEffect, useState} from 'react';
import {createPortal} from 'react-dom';

import {tableScrollEdges, type TableScrollEdges, type TableViewport, visibleTableViewport} from './scrollGeometry';
import './index.css';

const WRAPPER = '.PlaygroundEditorTheme__tableScrollableWrapper';
type Fade = TableViewport & TableScrollEdges & {element: HTMLElement};

export default function TableScrollShadowPlugin() {
  const [editor] = useLexicalComposerContext();
  const [fades, setFades] = useState<Fade[]>([]);

  useEffect(() => {
    const root = editor.getRootElement();
    const doc = root?.ownerDocument;
    const win = doc?.defaultView;
    if (!root || !doc || !win) return;
    const tracked = new Map<HTMLElement, () => void>();
    let frame: number | null = null;
    const measure = () => {
      frame = null;
      const next: Fade[] = [];
      for (const element of tracked.keys()) {
        const edges = tableScrollEdges(element);
        if (!edges.hasLeft && !edges.hasRight) continue;
        const visible = visibleTableViewport(element);
        if (visible) next.push({...visible, ...edges, element});
      }
      setFades(previous => previous.length === next.length && previous.every((fade, index) => {
        const other = next[index];
        return fade.element === other.element && fade.hasLeft === other.hasLeft && fade.hasRight === other.hasRight &&
          Math.abs(fade.top - other.top) < 0.25 && Math.abs(fade.bottom - other.bottom) < 0.25 &&
          Math.abs(fade.left - other.left) < 0.25 && Math.abs(fade.right - other.right) < 0.25;
      }) ? previous : next);
    };
    const schedule = () => {if (frame === null) frame = win.requestAnimationFrame(measure);};
    const observer = new ResizeObserver(schedule);
    const sync = () => {
      const wrappers = new Set(root.querySelectorAll<HTMLElement>(WRAPPER));
      for (const [element, dispose] of tracked) {
        if (!wrappers.has(element)) {dispose(); tracked.delete(element);}
      }
      for (const element of wrappers) {
        if (tracked.has(element)) continue;
        const table = element.querySelector('table');
        observer.observe(element);
        if (table) observer.observe(table);
        const cleanupPosition = autoUpdate(element, null, schedule, {
          ancestorScroll: false, ancestorResize: false, elementResize: false, layoutShift: true,
        });
        tracked.set(element, () => {
          observer.unobserve(element);
          if (table) observer.unobserve(table);
          cleanupPosition();
        });
      }
      schedule();
    };
    const mutations = new MutationObserver(sync);
    mutations.observe(root, {childList: true, subtree: true});
    doc.addEventListener('scroll', schedule, {capture: true, passive: true});
    win.addEventListener('resize', schedule);
    win.visualViewport?.addEventListener('resize', schedule);
    sync();
    return () => {
      if (frame !== null) win.cancelAnimationFrame(frame);
      mutations.disconnect();
      observer.disconnect();
      tracked.forEach(dispose => dispose());
      doc.removeEventListener('scroll', schedule, true);
      win.removeEventListener('resize', schedule);
      win.visualViewport?.removeEventListener('resize', schedule);
    };
  }, [editor]);

  const doc = editor.getRootElement()?.ownerDocument;
  if (!doc || !fades.length) return null;
  return createPortal(<div className="table-scroll-fades" aria-hidden="true">
    {fades.map((fade, index) => <div key={index} className={`table-scroll-fade${fade.hasLeft ? ' has-left' : ''}${fade.hasRight ? ' has-right' : ''}`}
      style={{left: fade.left, top: fade.top, width: fade.right - fade.left, height: fade.bottom - fade.top}} />)}
  </div>, doc.body);
}
