/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import './index.css';

import {Button, Select} from '@arco-design/web-react';
import {IconExport} from '@arco-design/web-react/icon';
import {$isCodeNode} from '@lexical/code';
import {DEFAULT_CODE_LANGUAGE} from '@lexical/code-core';
import {
  getCodeLanguageOptions,
  getLanguageFriendlyName,
  normalizeCodeLanguage,
} from '@lexical/code-prism';
import {useLexicalComposerContext} from '@lexical/react/LexicalComposerContext';
import {useLexicalEditable} from '@lexical/react/useLexicalEditable';
import {
  $getNearestNodeFromDOMNode,
  getComposedEventTarget,
  isHTMLElement,
  mergeRegister,
  type NodeKey,
  SKIP_DOM_SELECTION_TAG,
} from 'lexical';
import {type JSX, type ReactPortal, useCallback, useEffect, useRef, useState} from 'react';
import {createPortal} from 'react-dom';

import {
  $exitCodeBlock,
  $getCodeBlock,
  $getSelectedCodeBlock,
  $setCodeBlockLanguage,
  registerCodeWritingCommands,
} from './codeActions';
import {CopyButton} from './components/CopyButton';
import {PrettierButton} from './components/PrettierButton';
import {canBePrettier} from './formatCodeWithPrettier';
import {isMermaidLanguage} from '../MermaidPreviewPlugin/mermaid';

const LANGUAGE_OPTIONS = [
  {value: '', label: '未指定语言'},
  {value: 'plain', label: '纯文本'},
  ...getCodeLanguageOptions()
    .filter(([value]) => value !== 'plain')
    .map(([value, label]) => ({value, label})),
];

type ActiveCode = {key: NodeKey; language: string};
type Position = {top: number; left: number; width: number};

function CodeActionMenuContainer({anchorElem}: {anchorElem: HTMLElement}): JSX.Element | null {
  const [editor] = useLexicalComposerContext();
  const isEditable = useLexicalEditable();
  const [active, setActive] = useState<ActiveCode | null>(null);
  const [position, setPosition] = useState<Position | null>(null);
  const activeRef = useRef<ActiveCode | null>(null);
  const hoveredKeyRef = useRef<NodeKey | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const popupOpenRef = useRef(false);
  const frameRef = useRef(0);
  const focusFrameRef = useRef(0);

  const refresh = useCallback(() => {
    const root = editor.getRootElement();
    const doc = anchorElem.ownerDocument;
    const menuHasFocus = menuRef.current?.contains(doc.activeElement);
    const next = editor.read('latest', () => {
      const locked = (menuHasFocus || popupOpenRef.current) && activeRef.current
        ? $getCodeBlock(activeRef.current.key)
        : null;
      const hovered = hoveredKeyRef.current ? $getCodeBlock(hoveredKeyRef.current) : null;
      const selected = root?.contains(doc.activeElement) ? $getSelectedCodeBlock() : null;
      const code = locked || hovered || selected;
      // Mermaid has its own source/preview controls; do not cover those with
      // a second language/copy/exit menu when its CodeNode receives focus.
      return code && !isMermaidLanguage(code.getLanguage()) ? {key: code.getKey(), language: code.getLanguage() || ''} : null;
    });
    const codeDOM = next ? editor.getElementByKey(next.key) : null;
    if (!root || !next || !codeDOM?.isConnected || !root.contains(codeDOM)) {
      activeRef.current = null;
      popupOpenRef.current = false;
      setActive(null);
      setPosition(null);
      return;
    }
    activeRef.current = next;
    setActive(previous => previous?.key === next.key && previous.language === next.language ? previous : next);

    const codeRect = codeDOM.getBoundingClientRect();
    const anchorRect = anchorElem.getBoundingClientRect();
    const rootRect = root.getBoundingClientRect();
    const viewport = doc.documentElement;
    const minLeft = Math.max(codeRect.left + 4, rootRect.left, 4);
    const right = Math.min(codeRect.right - 4, rootRect.right, viewport.clientWidth - 4);
    const left = Math.max(minLeft, right - 268);
    // Float over the upper-right corner without reserving an empty header.
    // Once that corner scrolls away, don't cover another block's content.
    if (right <= left || codeRect.top + 4 < 0 || codeRect.top + 32 > viewport.clientHeight) {
      setPosition(null);
      return;
    }
    // Let a first-line caret/selection use the full width while typing. The
    // tools remain reachable by moving over the block or pressing Alt+F10.
    const selection = doc.getSelection();
    if (!hoveredKeyRef.current && !menuHasFocus && !popupOpenRef.current &&
        selection?.rangeCount && codeDOM.contains(selection.anchorNode)) {
      const rect = selection.getRangeAt(0).getBoundingClientRect();
      if (rect.right >= left && rect.left <= right && rect.top < codeRect.top + 34 && rect.bottom > codeRect.top) {
        setPosition(null);
        return;
      }
    }
    const measured = {
      left: left - anchorRect.left + anchorElem.scrollLeft - anchorElem.clientLeft,
      top: codeRect.top - anchorRect.top + anchorElem.scrollTop - anchorElem.clientTop + 4,
      width: right - left,
    };
    setPosition(previous => previous?.left === measured.left && previous.top === measured.top && previous.width === measured.width ? previous : measured);
  }, [editor, anchorElem]);

  const scheduleRefresh = useCallback(() => {
    if (frameRef.current) return;
    frameRef.current = requestAnimationFrame(() => {
      frameRef.current = 0;
      refresh();
    });
  }, [refresh]);

  useEffect(() => {
    const doc = anchorElem.ownerDocument;
    const win = doc.defaultView!;
    const onPointerMove = (event: PointerEvent) => {
      const target = getComposedEventTarget(event);
      if (target instanceof win.Node && menuRef.current?.contains(target)) return;
      const root = editor.getRootElement();
      const codeDOM = isHTMLElement(target) ? target.closest<HTMLElement>('code.PlaygroundEditorTheme__code') : null;
      const key = codeDOM && root?.contains(codeDOM) ? editor.read('latest', () => {
        const code = $getNearestNodeFromDOMNode(codeDOM);
        return $isCodeNode(code) && editor.getElementByKey(code.getKey()) === codeDOM ? code.getKey() : null;
      }) : null;
      if (key !== hoveredKeyRef.current) {
        hoveredKeyRef.current = key;
        scheduleRefresh();
      }
    };
    const onPointerLeave = () => {
      hoveredKeyRef.current = null;
      scheduleRefresh();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.target instanceof win.Node && editor.getRootElement()?.contains(event.target)) {
        hoveredKeyRef.current = null;
        scheduleRefresh();
      }
    };
    doc.addEventListener('pointermove', onPointerMove);
    doc.addEventListener('pointerleave', onPointerLeave);
    doc.addEventListener('focusin', scheduleRefresh);
    doc.addEventListener('focusout', scheduleRefresh);
    doc.addEventListener('keydown', onKeyDown, true);
    doc.addEventListener('scroll', scheduleRefresh, true);
    win.addEventListener('resize', scheduleRefresh);
    scheduleRefresh();
    return mergeRegister(
      editor.registerUpdateListener(scheduleRefresh),
      editor.registerRootListener((root, previous) => {
        previous?.classList.remove('has-code-action-menu');
        root?.classList.add('has-code-action-menu');
        scheduleRefresh();
      }),
      registerCodeWritingCommands(editor, key => {
        const codeDOM = editor.getElementByKey(key);
        if (codeDOM?.hasAttribute('data-mermaid-view')) {
          // The Mermaid source toolbar replaces this menu, including its
          // keyboard entry point. It lives outside the editable root.
          const toolbar = [...anchorElem.querySelectorAll<HTMLElement>('.mermaid-source-toolbar')]
            .find(element => element.dataset.mermaidKey === key);
          toolbar?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
          return;
        }
        hoveredKeyRef.current = key;
        scheduleRefresh();
        cancelAnimationFrame(focusFrameRef.current);
        focusFrameRef.current = requestAnimationFrame(() => {
          focusFrameRef.current = requestAnimationFrame(() => {
            menuRef.current?.querySelector<HTMLElement>('[role="combobox"]:not([aria-disabled="true"]), button:not(:disabled)')?.focus();
          });
        });
      }),
      () => {
        doc.removeEventListener('pointermove', onPointerMove);
        doc.removeEventListener('pointerleave', onPointerLeave);
        doc.removeEventListener('focusin', scheduleRefresh);
        doc.removeEventListener('focusout', scheduleRefresh);
        doc.removeEventListener('keydown', onKeyDown, true);
        doc.removeEventListener('scroll', scheduleRefresh, true);
        win.removeEventListener('resize', scheduleRefresh);
        cancelAnimationFrame(frameRef.current);
        cancelAnimationFrame(focusFrameRef.current);
        frameRef.current = 0;
        editor.getRootElement()?.classList.remove('has-code-action-menu');
      },
    );
  }, [editor, anchorElem, scheduleRefresh]);

  useEffect(() => {
    const observer = new ResizeObserver(scheduleRefresh);
    observer.observe(anchorElem);
    const root = editor.getRootElement();
    if (root) observer.observe(root);
    const code = active ? editor.getElementByKey(active.key) : null;
    if (code) observer.observe(code);
    return () => observer.disconnect();
  }, [editor, anchorElem, active?.key, scheduleRefresh]);

  if (!active) return null;
  const language = normalizeCodeLanguage(active.language);
  const options = LANGUAGE_OPTIONS.some(option => option.value === language)
    ? LANGUAGE_OPTIONS
    : [...LANGUAGE_OPTIONS, {value: language, label: getLanguageFriendlyName(language)}];
  // Preserve the previous formatter for unspecified code, without assigning a
  // language in the document. Explicit plain text never offers JS formatting.
  const formatLanguage = normalizeCodeLanguage(active.language || DEFAULT_CODE_LANGUAGE);

  return (
    <div
      key={active.key}
      ref={menuRef}
      className="code-action-menu-container"
      role="group"
      aria-label="代码块工具（Alt+F10 聚焦，Esc 返回正文）"
      style={position ? position : {visibility: 'hidden', pointerEvents: 'none'}}
      onKeyDown={event => {
        if (event.key === 'Escape' && !popupOpenRef.current) {
          event.preventDefault();
          event.stopPropagation();
          editor.focus();
        }
      }}>
      <div className="code-action-menu-row">
        <Select
          size="mini"
          className="code-language-select"
          aria-label="代码块语言"
          showSearch
          disabled={!isEditable}
          value={language}
          options={options}
          notFoundContent="没有匹配的语言"
          filterOption={(query, option) => {
            const props = option.props as {value: string; children: string};
            return `${props.value} ${props.children}`.toLowerCase().includes(query.toLowerCase());
          }}
          getPopupContainer={() => menuRef.current || anchorElem}
          dropdownMenuClassName="code-language-options"
          triggerProps={{autoAlignPopupWidth: false, autoFitPosition: true}}
          onVisibleChange={visible => {
            popupOpenRef.current = visible;
            scheduleRefresh();
          }}
          onChange={(value: string) => {
            editor.update(() => $setCodeBlockLanguage(editor, active.key, value), {tag: SKIP_DOM_SELECTION_TAG});
          }}
        />
        <CopyButton editor={editor} codeKey={active.key} />
        {canBePrettier(formatLanguage) && (
          <PrettierButton key={formatLanguage} editor={editor} codeKey={active.key} lang={formatLanguage} disabled={!isEditable} getFeedbackContainer={() => menuRef.current} />
        )}
        <Button
          type="text"
          htmlType="button"
          size="mini"
          className="code-action-button"
          disabled={!isEditable}
          aria-label="退出代码块"
          aria-keyshortcuts="Meta+Enter Control+Enter"
          title="退出代码块（⌘/Ctrl + Enter）"
          icon={<IconExport />}
          onMouseDown={event => event.preventDefault()}
          onClick={() => {
            hoveredKeyRef.current = null;
            editor.update(() => {
              if ($exitCodeBlock(editor, active.key)) editor.getRootElement()?.focus({preventScroll: true});
            });
          }}
        />
      </div>
    </div>
  );
}

export default function CodeActionMenuPlugin({anchorElem = document.body}: {anchorElem?: HTMLElement}): ReactPortal {
  return createPortal(<CodeActionMenuContainer anchorElem={anchorElem} />, anchorElem);
}
