import './index.css';

import { Button } from '@arco-design/web-react';
import {
  IconBranch,
  IconCheck,
  IconCode,
  IconExpand,
  IconExclamationCircle,
  IconLoading,
} from '@arco-design/web-react/icon';
import { CodeNode, $isCodeNode } from '@lexical/code';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import { useLexicalEditable } from '@lexical/react/useLexicalEditable';
import {
  $getNodeByKey,
  $getSelection,
  $isRangeSelection,
  $nodesOfType,
  type LexicalEditor,
  type LexicalNode,
  mergeRegister,
  type NodeKey,
} from 'lexical';
import { type JSX, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { CopyButton } from '../CodeActionMenuPlugin/components/CopyButton';
import DiagramViewer from './DiagramViewer';
import { getDiagramLabel } from './diagramViewport';
import {
  isMermaidLanguage,
  MERMAID_DEBOUNCE_MS,
  MermaidPreviewError,
  type MermaidTheme,
  readMermaidSVGSize,
  readMermaidTheme,
  renderMermaid,
} from './mermaid';

type Block = { key: NodeKey; source: string; element: HTMLElement };
type Position = { top: number; sourceTop: number; left: number; width: number; visible: boolean; clipPath: string };
type RenderState = { svg: string; pending: boolean; error: MermaidPreviewError | null };

function $codeAncestor(node: LexicalNode): CodeNode | null {
  if ($isCodeNode(node)) return node;
  return node.getParents().find($isCodeNode) || null;
}

function useHostTheme(anchor: HTMLElement): MermaidTheme {
  const [theme, setTheme] = useState(() => readMermaidTheme(anchor));
  useEffect(() => {
    const doc = anchor.ownerDocument;
    const win = doc.defaultView!;
    let frame = 0;
    const refresh = () => {
      if (frame) return;
      frame = win.requestAnimationFrame(() => {
        frame = 0;
        const next = readMermaidTheme(anchor);
        setTheme((previous) => (JSON.stringify(previous) === JSON.stringify(next) ? previous : next));
      });
    };
    const observer = new win.MutationObserver(refresh);
    const options = {
      attributes: true,
      attributeFilter: ['style', 'class', 'data-appearance', 'data-theme', 'arco-theme'],
    };
    observer.observe(doc.documentElement, options);
    observer.observe(doc.body, options);
    refresh();
    return () => {
      observer.disconnect();
      win.cancelAnimationFrame(frame);
    };
  }, [anchor]);
  return theme;
}

function MermaidBlockPreview({
  block,
  editor,
  anchor,
  sourceMode,
  setSourceMode,
  theme,
  editable,
}: {
  block: Block;
  editor: LexicalEditor;
  anchor: HTMLElement;
  sourceMode: boolean;
  setSourceMode: (key: NodeKey, showSource: boolean) => void;
  theme: MermaidTheme;
  editable: boolean;
}): JSX.Element {
  const previewRef = useRef<HTMLDivElement>(null);
  const previewHeightRef = useRef(88);
  const focusSourceRef = useRef(false);
  const firstRenderRef = useRef(true);
  const [retry, setRetry] = useState(0);
  const [viewerOpen, setViewerOpen] = useState(false);
  const sourceButtonRef = useRef<HTMLButtonElement>(null);
  const restoreToolbarFocusRef = useRef(false);
  const [render, setRender] = useState<RenderState>({ svg: '', pending: true, error: null });
  const [position, setPosition] = useState<Position>({
    top: 0,
    sourceTop: 0,
    left: 0,
    width: 0,
    visible: false,
    clipPath: '',
  });
  const { element, key, source } = block;
  const diagram = useMemo(
    () => readMermaidSVGSize(render.svg, element.ownerDocument),
    [render.svg, element.ownerDocument],
  );
  const label = useMemo(() => getDiagramLabel(source), [source]);
  const closeViewer = useCallback(() => setViewerOpen(false), []);

  // Only presentation attributes/styles belong to this plugin. Never insert a
  // child or sibling inside Lexical's contenteditable root: its reconciler and
  // MutationObserver must remain the sole owners of that subtree.
  useLayoutEffect(() => {
    const previousHidden = element.getAttribute('aria-hidden');
    return () => {
      element.removeAttribute('data-mermaid-view');
      element.style.removeProperty('--mermaid-preview-height');
      if (previousHidden === null) element.removeAttribute('aria-hidden');
      else element.setAttribute('aria-hidden', previousHidden);
    };
  }, [element]);

  useLayoutEffect(() => {
    element.dataset.mermaidView = sourceMode ? 'source' : 'preview';
    if (sourceMode) element.removeAttribute('aria-hidden');
    else element.setAttribute('aria-hidden', 'true');
    element.style.setProperty('--mermaid-preview-height', `${previewHeightRef.current}px`);
    if (!sourceMode && restoreToolbarFocusRef.current) {
      restoreToolbarFocusRef.current = false;
      sourceButtonRef.current?.focus({ preventScroll: true });
    }
    if (sourceMode && focusSourceRef.current && editor.isEditable()) {
      focusSourceRef.current = false;
      editor.update(
        () => {
          const code = $getNodeByKey(key);
          if (!$isCodeNode(code)) return;
          const selection = $getSelection();
          if (!$isRangeSelection(selection) || $codeAncestor(selection.anchor.getNode())?.getKey() !== key) {
            code.selectEnd();
          }
        },
        { discrete: true },
      );
      editor.getRootElement()?.focus({ preventScroll: true });
    }
  }, [editor, element, key, sourceMode]);

  useEffect(() => {
    let disposed = false;
    const immediate = firstRenderRef.current;
    firstRenderRef.current = false;
    setRender((previous) => ({ ...previous, pending: true, error: null }));
    const timer = anchor.ownerDocument.defaultView!.setTimeout(
      () => {
        void renderMermaid(
          source,
          theme,
          element.ownerDocument,
          element.clientWidth - 24,
          () => !disposed && element.isConnected,
        )
          .then((svg) => {
            if (!disposed && svg !== undefined) setRender({ svg, pending: false, error: null });
          })
          .catch((error) => {
            if (disposed) return;
            const message =
              error instanceof MermaidPreviewError
                ? error
                : new MermaidPreviewError('network', '图表组件加载失败，请重试。');
            // Keep the last successful diagram while typing temporarily invalid
            // input. The error below clearly marks that preview as out of date.
            setRender((previous) => ({ svg: previous.svg, pending: false, error: message }));
            // Broken input and offline CDN failures expose the original editable
            // CodeNode, with a compact explanation underneath it.
            setSourceMode(key, true);
          });
      },
      immediate ? 0 : MERMAID_DEBOUNCE_MS,
    );
    return () => {
      disposed = true;
      anchor.ownerDocument.defaultView!.clearTimeout(timer);
    };
  }, [source, theme, retry, element, anchor, key, setSourceMode]);

  useLayoutEffect(() => {
    const preview = previewRef.current;
    if (!preview) return;
    const doc = anchor.ownerDocument;
    const win = doc.defaultView!;
    let frame = 0;
    const refresh = () => {
      if (!element.isConnected || !editor.getRootElement()?.contains(element)) return;
      const rect = element.getBoundingClientRect();
      if (!rect.width || !element.getClientRects().length) {
        setPosition((previous) => (previous.visible ? { ...previous, visible: false } : previous));
        return;
      }
      const anchorRect = anchor.getBoundingClientRect();
      const height = Math.max(64, Math.ceil(preview.getBoundingClientRect().height));
      if (height !== previewHeightRef.current) {
        previewHeightRef.current = height;
        element.style.setProperty('--mermaid-preview-height', `${height}px`);
      }
      // Source mode reserves padding below the code, so the preview can stay a
      // portal outside the editable tree while still participating in its flow.
      const updated = element.getBoundingClientRect();
      // A portal must still respect nested horizontal scrollers (notably a
      // wide table); otherwise it can cover neighbouring cells after a scroll.
      let clipLeft = 0,
        clipRight = 0;
      for (let parent = element.parentElement; parent && parent !== anchor; parent = parent.parentElement) {
        if (!/^(?:auto|scroll|hidden|clip)$/.test(win.getComputedStyle(parent).overflowX)) continue;
        const bounds = parent.getBoundingClientRect();
        clipLeft = Math.max(clipLeft, bounds.left + parent.clientLeft - updated.left);
        clipRight = Math.max(clipRight, updated.right - bounds.left - parent.clientLeft - parent.clientWidth);
      }
      clipLeft = Math.max(0, clipLeft);
      clipRight = Math.max(0, clipRight);
      const measured: Position = {
        top:
          (sourceMode ? updated.bottom - height : updated.top) - anchorRect.top + anchor.scrollTop - anchor.clientTop,
        sourceTop: updated.top - anchorRect.top + anchor.scrollTop - anchor.clientTop,
        left: updated.left - anchorRect.left + anchor.scrollLeft - anchor.clientLeft,
        width: updated.width,
        visible: clipLeft + clipRight < updated.width,
        clipPath: clipLeft || clipRight ? `inset(0 ${clipRight}px 0 ${clipLeft}px)` : '',
      };
      setPosition((previous) =>
        previous.top === measured.top &&
        previous.sourceTop === measured.sourceTop &&
        previous.left === measured.left &&
        previous.width === measured.width &&
        previous.visible === measured.visible &&
        previous.clipPath === measured.clipPath
          ? previous
          : measured,
      );
    };
    const schedule = () => {
      if (frame) return;
      frame = win.requestAnimationFrame(() => {
        frame = 0;
        refresh();
      });
    };
    const observer = new win.ResizeObserver(schedule);
    observer.observe(preview);
    observer.observe(element);
    observer.observe(anchor);
    const root = editor.getRootElement();
    if (root) observer.observe(root);
    doc.addEventListener('scroll', schedule, true);
    win.addEventListener('resize', schedule);
    // Moving/reordering an equal-sized paragraph changes offsets, not sizes.
    const unregister = editor.registerUpdateListener(schedule);
    refresh();
    return () => {
      observer.disconnect();
      doc.removeEventListener('scroll', schedule, true);
      win.removeEventListener('resize', schedule);
      win.cancelAnimationFrame(frame);
      unregister();
    };
  }, [editor, element, anchor, sourceMode]);

  const showSource = () => {
    focusSourceRef.current = editable;
    setSourceMode(key, true);
  };
  const actions = (
    <div className="mermaid-preview-actions" role="group" aria-label="Mermaid 图表工具">
      <span className="mermaid-preview-label">
        <IconBranch aria-hidden="true" />
        <span>{label}</span>
        <span className="mermaid-preview-kind">Mermaid</span>
      </span>
      {render.pending && (
        <span className="mermaid-preview-updating" title="正在更新图表" aria-label="正在更新图表">
          <IconLoading aria-hidden="true" />
        </span>
      )}
      <CopyButton editor={editor} codeKey={key} label="复制 Mermaid 源码" />
      <Button
        ref={sourceButtonRef}
        type="text"
        size="mini"
        htmlType="button"
        className="mermaid-view-button"
        icon={sourceMode ? <IconCheck /> : <IconCode />}
        aria-label={sourceMode ? '收起 Mermaid 源码' : editable ? '编辑 Mermaid 源码' : '查看 Mermaid 源码'}
        aria-expanded={sourceMode}
        title={sourceMode ? '收起源码，仅显示图表' : editable ? '编辑源码，下方实时预览' : '查看图表源码'}
        onClick={() => {
          if (sourceMode) {
            sourceButtonRef.current?.focus({ preventScroll: true });
            // Focus the button that survives collapsing the source header.
            focusSourceRef.current = false;
            restoreToolbarFocusRef.current = true;
            setSourceMode(key, false);
          } else showSource();
        }}
      >
        {sourceMode ? '完成' : '源码'}
      </Button>
      <span className="mermaid-toolbar-divider" />
      <Button
        type="text"
        size="mini"
        htmlType="button"
        icon={<IconExpand />}
        disabled={!render.svg}
        aria-label="放大查看 Mermaid 图表"
        title="放大查看图表"
        onClick={() => setViewerOpen(true)}
      />
    </div>
  );
  return createPortal(
    <>
      {sourceMode && (
        <div
          className="mermaid-source-toolbar"
          data-mermaid-key={key}
          style={{
            top: position.sourceTop,
            left: position.left,
            width: position.width || undefined,
            visibility: position.visible ? 'visible' : 'hidden',
            clipPath: position.clipPath,
          }}
        >
          {actions}
        </div>
      )}
      <div
        ref={previewRef}
        className={`mermaid-preview${sourceMode ? ' mermaid-preview-live' : ''}${render.error ? ' has-error' : ''}`}
        data-mermaid-key={key}
        role="region"
        aria-label={sourceMode ? 'Mermaid 实时预览' : 'Mermaid 图表'}
        aria-busy={render.pending}
        style={{
          top: position.top,
          left: position.left,
          width: position.width || undefined,
          visibility: position.visible ? 'visible' : 'hidden',
          clipPath: position.clipPath,
        }}
      >
        {!sourceMode && actions}
        {sourceMode && (
          <div className="mermaid-preview-live-label">{render.error && render.svg ? '上次成功的预览' : '实时预览'}</div>
        )}
        {render.svg ? (
          <div
            className={`mermaid-preview-diagram${render.error ? ' is-stale' : ''}`}
            style={{ aspectRatio: `${diagram.width} / ${diagram.height}`, maxWidth: diagram.width }}
            role="button"
            tabIndex={0}
            aria-label="放大查看 Mermaid 图表"
            title="点击放大查看"
            onClick={() => setViewerOpen(true)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                setViewerOpen(true);
              }
            }}
          >
            {viewerOpen ? (
              <span className="mermaid-viewer-placeholder">正在放大查看</span>
            ) : (
              <div className="mermaid-preview-svg" dangerouslySetInnerHTML={{ __html: render.svg }} />
            )}
            <span className="mermaid-preview-expand-hint" aria-hidden="true">
              <IconExpand /> 放大查看
            </span>
          </div>
        ) : null}
        <div
          className={`mermaid-preview-status${render.error ? ' mermaid-preview-error' : ''}${render.svg && !render.error ? ' mermaid-preview-status-quiet' : ''}`}
          role="status"
          aria-live="polite"
          aria-atomic="true"
        >
          {render.error ? (
            <>
              <IconExclamationCircle aria-hidden="true" />
              <span>
                {render.error.message}
                {render.svg ? ' 保留上次成功的预览。' : ''}
              </span>
              {render.error.kind === 'network' && (
                <Button type="text" size="mini" htmlType="button" onClick={() => setRetry((value) => value + 1)}>
                  重试
                </Button>
              )}
            </>
          ) : !render.svg ? (
            <>
              <IconBranch aria-hidden="true" />
              <span>{render.pending ? '正在载入图表…' : '输入 Mermaid 源码后预览图表'}</span>
            </>
          ) : null}
        </div>
      </div>
      {viewerOpen && render.svg && (
        <DiagramViewer
          svg={render.svg}
          diagram={diagram}
          label={label}
          stale={!!render.error || render.pending}
          onClose={closeViewer}
        />
      )}
    </>,
    anchor,
  );
}

/** Mount next to CodeActionMenuPlugin, using the same .editor portal anchor. */
export default function MermaidPreviewPlugin({ anchorElem }: { anchorElem: HTMLElement }): JSX.Element {
  const [editor] = useLexicalComposerContext();
  const editable = useLexicalEditable();
  const [blocks, setBlocks] = useState<Block[]>([]);
  const [sourceKeys, setSourceKeys] = useState<ReadonlySet<NodeKey>>(() => new Set());
  const theme = useHostTheme(anchorElem);
  const setSourceMode = useCallback((key: NodeKey, showSource: boolean) => {
    setSourceKeys((previous) => {
      if (previous.has(key) === showSource) return previous;
      const next = new Set(previous);
      if (showSource) next.add(key);
      else next.delete(key);
      return next;
    });
  }, []);

  useEffect(() => {
    const refresh = () => {
      const root = editor.getRootElement();
      const doc = anchorElem.ownerDocument;
      const { next, selected } = editor.read('latest', () => {
        const next = $nodesOfType(CodeNode).flatMap((node) => {
          const element = editor.getElementByKey(node.getKey());
          return isMermaidLanguage(node.getLanguage()) && element && root?.contains(element)
            ? [{ key: node.getKey(), source: node.getTextContent(), element }]
            : [];
        });
        const selection = $getSelection();
        const selected =
          root?.contains(doc.activeElement) && $isRangeSelection(selection)
            ? [selection.anchor.getNode(), selection.focus.getNode()].flatMap((node) => {
                const code = $codeAncestor(node);
                return code ? [code.getKey()] : [];
              })
            : [];
        return { next, selected };
      });
      setBlocks((previous) =>
        previous.length === next.length &&
        previous.every(
          (block, index) =>
            block.key === next[index].key &&
            block.source === next[index].source &&
            block.element === next[index].element,
        )
          ? previous
          : next,
      );
      setSourceKeys((previous) => {
        const liveKeys = new Set(next.map((block) => block.key));
        const nextKeys = new Set([...previous].filter((key) => liveKeys.has(key)));
        // Keyboard navigation/selection into a collapsed CodeNode must expose
        // its actual source before the user types. No selection is rewritten.
        for (const key of selected) if (liveKeys.has(key)) nextKeys.add(key);
        return nextKeys.size === previous.size && [...nextKeys].every((key) => previous.has(key)) ? previous : nextKeys;
      });
    };
    const doc = anchorElem.ownerDocument;
    doc.addEventListener('focusin', refresh);
    return mergeRegister(editor.registerUpdateListener(refresh), editor.registerRootListener(refresh), () =>
      doc.removeEventListener('focusin', refresh),
    );
  }, [editor, anchorElem]);

  return (
    <>
      {blocks.map((block) => (
        <MermaidBlockPreview
          key={block.key}
          block={block}
          editor={editor}
          anchor={anchorElem}
          sourceMode={sourceKeys.has(block.key)}
          setSourceMode={setSourceMode}
          theme={theme}
          editable={editable}
        />
      ))}
    </>
  );
}
