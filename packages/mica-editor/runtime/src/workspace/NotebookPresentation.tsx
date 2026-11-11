import {useLexicalComposerContext} from '@lexical/react/LexicalComposerContext';
import {$getRoot, COMMAND_PRIORITY_LOW} from 'lexical';
import {useCallback, useEffect, useLayoutEffect, useRef, useState} from 'react';

import {Button} from '../../../../mica-config-ui/web/components/Ui';
import {useNotebookSession} from './NotebookBridge';
import {NOTEBOOK_ACTION_COMMAND} from './notebookActions';
import {$readNotebookSlides, type NotebookSlide} from './presentation';
import './notebook-presentation.css';

function Arrow({previous = false}: {previous?: boolean}) {
  return <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={previous ? 'm10 3-5 5 5 5' : 'm6 3 5 5-5 5'} /></svg>;
}

export default function NotebookPresentation() {
  const [editor] = useLexicalComposerContext();
  const session = useNotebookSession();
  const [slides, setSlides] = useState<NotebookSlide[] | null>(null);
  const [index, setIndex] = useState(0);
  const open = useRef(false);
  const controls = useRef<HTMLElement>(null);
  const close = useCallback(() => {open.current = false; setSlides(null);}, []);

  useEffect(() => editor.registerCommand(NOTEBOOK_ACTION_COMMAND, action => {
    if (action !== 'present') {close(); return false;}
    if (open.current) close();
    else if (!editor.isComposing()) {
      setSlides(editor.getEditorState().read($readNotebookSlides));
      setIndex(0);
      open.current = true;
    }
    // Every document surface observes the command to close its own panel.
    return false;
  }, COMMAND_PRIORITY_LOW), [close, editor]);

  useLayoutEffect(() => {
    if (!slides || !session) return;
    const root = editor.getRootElement();
    const workspace = root?.closest<HTMLElement>('.notebook-workbench');
    if (!root || !workspace) return;
    const focused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const scroll = {x: window.scrollX, y: window.scrollY};
    session.setPresenting(true);
    workspace.dataset.presenting = 'true';
    document.body.dataset.notebookPresentation = 'true';
    controls.current?.focus({preventScroll: true});
    window.dispatchEvent(new Event('resize'));
    return () => {
      delete workspace.dataset.presenting;
      delete document.body.dataset.notebookPresentation;
      for (const element of root.querySelectorAll('[data-notebook-slide-hidden]')) element.removeAttribute('data-notebook-slide-hidden');
      session.setPresenting(false);
      window.scrollTo(scroll.x, scroll.y);
      if (focused?.isConnected) focused.focus({preventScroll: true});
      window.dispatchEvent(new Event('resize'));
    };
  }, [editor, session, slides]);

  useLayoutEffect(() => {
    if (!slides) return;
    const visible = new Set(slides[index].keys);
    editor.getEditorState().read(() => {
      for (const block of $getRoot().getChildren()) {
        editor.getElementByKey(block.getKey())?.setAttribute('data-notebook-slide-hidden', String(!visible.has(block.getKey())));
      }
    });
    editor.getRootElement()?.closest('.editor-scroller')?.scrollTo({top: 0, left: 0});
    window.dispatchEvent(new Event('resize'));
  }, [editor, index, slides]);

  useEffect(() => {
    if (!slides) return;
    const keydown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing || event.keyCode === 229 || event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.key === 'Escape') {event.preventDefault(); close(); return;}
      if (event.target instanceof HTMLElement && event.target.closest('input, textarea, [role="dialog"]')) return;
      if (['ArrowRight', 'ArrowDown', 'PageDown', ' '].includes(event.key) && !event.shiftKey) {
        event.preventDefault(); setIndex(previous => Math.min(slides.length - 1, previous + 1));
      } else if (['ArrowLeft', 'ArrowUp', 'PageUp'].includes(event.key) || (event.key === ' ' && event.shiftKey)) {
        event.preventDefault(); setIndex(previous => Math.max(0, previous - 1));
      } else if (event.key === 'Home' || event.key === 'End') {
        event.preventDefault(); setIndex(event.key === 'Home' ? 0 : slides.length - 1);
      }
    };
    window.addEventListener('keydown', keydown);
    return () => window.removeEventListener('keydown', keydown);
  }, [close, slides]);

  if (!slides) return null;
  return <nav className="notebook-presentation-controls" aria-label="文档演示" tabIndex={-1} ref={controls}>
    <div className="notebook-presentation-title"><strong>{slides[index].title}</strong><span>方向键翻页 · Esc 退出</span></div>
    <div className="notebook-presentation-pagination">
      <Button size="compact" variant="ghost" title="上一页（←）" aria-label="上一页" disabled={index === 0} icon={<Arrow previous />} onClick={() => setIndex(previous => Math.max(0, previous - 1))} />
      <output aria-live="polite">{index + 1} / {slides.length}</output>
      <Button size="compact" variant="ghost" title="下一页（→）" aria-label="下一页" disabled={index === slides.length - 1} icon={<Arrow />} onClick={() => setIndex(previous => Math.min(slides.length - 1, previous + 1))} />
    </div>
    <Button variant="ghost" size="compact" onClick={close}>退出演示</Button>
  </nav>;
}
