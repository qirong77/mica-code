import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import Button from '@arco-design/web-react/es/Button';
import '@arco-design/web-react/es/style/index.css';
import '@arco-design/web-react/es/Button/style/index.css';

const SearchModal = lazy(() => import('./SearchModal'));

export interface SearchPage {
  key: string;
  title: string;
  description: string;
}

interface Props {
  pages: SearchPage[];
  base: string;
}

export default function DocsSearch({ pages, base }: Props) {
  const [open, setOpen] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [shortcut, setShortcut] = useState('⌘ K');
  const trigger = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!/Mac|iPhone|iPad/.test(navigator.platform)) setShortcut('Ctrl K');
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.isComposing || event.keyCode === 229) return;
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setLoaded(true);
        setOpen((current) => !current);
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, []);

  return (
    <>
      <Button
        ref={trigger}
        className="search-trigger"
        aria-haspopup="dialog"
        aria-keyshortcuts="Meta+K Control+K"
        onClick={() => {
          setLoaded(true);
          setOpen(true);
        }}
      >
        <svg
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.7"
          aria-hidden="true"
        >
          <circle cx="11" cy="11" r="7" />
          <path d="m16 16 4 4" />
        </svg>
        <span>搜索文档…</span>
        <kbd>{shortcut}</kbd>
      </Button>
      {loaded && (
        <Suspense fallback={null}>
          <SearchModal
            pages={pages}
            base={base}
            visible={open}
            onClose={() => setOpen(false)}
            onAfterClose={() => trigger.current?.focus()}
          />
        </Suspense>
      )}
    </>
  );
}
