import React, { useRef, useState } from 'react';
import { PanelLeftClose, RefreshCw, Sparkles } from 'lucide-react';
import { Button } from '@mica-config-ui/web';

/** Notebook owns the layout and reference intent; all conversation behavior belongs to Mica. */
/** @param {{api: any, open?: boolean, note?: {id: string, title: string} | null,
 * reference?: {label: string, getText: () => Promise<string>} | null,
 * onCheckUpdates?: () => void, onClose: () => void}} props */
export function NotebookChatDock({ api, open = true, note = null, reference = null, onCheckUpdates, onClose }) {
  const Conversation = api?.ui?.Conversation;
  const [general, setGeneral] = useState(() => api?.page?.search?.().chat === 'general');
  const chooseGeneral = (value) => {
    setGeneral(value);
    api?.page?.setSearch?.({ ...api.page.search?.(), chat: value ? 'general' : null });
  };
  const [width, setWidth] = useState(null);
  const panel = useRef(null);
  const resize = useRef(null);
  const scope = !general && note ? `note:${note.id}` : 'general';

  return (
    <>
      {open && (
        <button
          type="button"
          className="notebook-chat-mask"
          tabIndex={-1}
          aria-label="收起对话浮层"
          onClick={onClose}
        />
      )}
      <aside
        ref={panel}
        className="notebook-chat"
        style={{ '--notebook-chat-width': width ? `${width}px` : undefined, display: open ? undefined : 'none' }}
        aria-label="AI 对话"
        inert={!open}
      >
        <div
          className="notebook-chat-resize"
          role="separator"
          aria-label="调整对话宽度"
          aria-orientation="vertical"
          aria-valuemin={360}
          aria-valuemax={800}
          aria-valuenow={width || 460}
          tabIndex={0}
          onPointerDown={(event) => {
            if (event.button !== 0) return;
            resize.current = { x: event.clientX, width: panel.current.getBoundingClientRect().width };
            event.currentTarget.setPointerCapture(event.pointerId);
            event.preventDefault();
          }}
          onPointerMove={(event) => {
            if (!resize.current) return;
            setWidth(Math.max(360, Math.min(800, resize.current.width + resize.current.x - event.clientX)));
          }}
          onPointerUp={(event) => {
            resize.current = null;
            event.currentTarget.releasePointerCapture(event.pointerId);
          }}
          onLostPointerCapture={() => {
            resize.current = null;
          }}
          onDoubleClick={() => setWidth(null)}
          onKeyDown={(event) => {
            if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
            event.preventDefault();
            setWidth(
              Math.max(
                360,
                Math.min(
                  800,
                  (width || panel.current.getBoundingClientRect().width) + (event.key === 'ArrowLeft' ? 24 : -24),
                ),
              ),
            );
          }}
        />
        <header className="notebook-chat-head">
          <div className="notebook-chat-heading">
            <span className="notebook-chat-heading-icon" aria-hidden="true">
              <Sparkles size={16} strokeWidth={1.7} />
            </span>
            <span className="notebook-chat-heading-copy">
              <strong>AI 对话</strong>
              <small title={!general && note ? note.title : '跨笔记讨论'}>
                {!general && note ? note.title : '跨笔记讨论'}
              </small>
            </span>
          </div>
          {onCheckUpdates && (
            <Button
              variant="ghost"
              iconOnly
              icon={<RefreshCw size={14} />}
              title="检查笔记更新"
              aria-label="检查笔记更新"
              onClick={onCheckUpdates}
            />
          )}
          <Button
            variant="ghost"
            iconOnly
            icon={<PanelLeftClose size={15} />}
            title="收起对话"
            aria-label="收起对话"
            onClick={onClose}
          />
        </header>
        <div className="notebook-chat-scope" role="group" aria-label="对话归属">
          <Button
            size="compact"
            variant={!general ? 'primary' : 'ghost'}
            disabled={!note}
            pressed={!general && !!note}
            onClick={() => chooseGeneral(false)}
          >
            当前笔记
          </Button>
          <Button
            size="compact"
            variant={general || !note ? 'primary' : 'ghost'}
            pressed={general || !note}
            onClick={() => chooseGeneral(true)}
          >
            跨笔记对话
          </Button>
        </div>
        <p className="notebook-chat-hint">
          当前笔记不会自动附加。工具权限与主对话一致；需要时先引用，再说明要讨论还是修改。
        </p>
        <div className="notebook-chat-content">
          {Conversation ? (
            <Conversation key={scope} scope={scope} visible={open} reference={reference} />
          ) : (
            <p className="notebook-chat-empty">当前宿主未提供可嵌入的 Mica 对话能力。</p>
          )}
        </div>
      </aside>
    </>
  );
}
