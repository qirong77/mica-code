import { useEffect, useRef, useState } from 'react';
import type { LucideIcon } from 'lucide-react';
import { openPathInEditor, revealPath, supportsPathEditor, supportsPathReveal } from '../api.js';
import { appIcons } from '../icons.js';
import type { ConfigWebPathAction } from '../../src/shared/types.js';

type PathMenuAction = {
  key: string;
  label: string;
  Icon: LucideIcon;
  run(): Promise<ConfigWebPathAction>;
};

/** 菜单宽度与每项高度：固定浮层按视口坐标摆位，得先知道自己多大。 */
const MENU_WIDTH = 208;
const MENU_ITEM_HEIGHT = 30;
const MENU_PADDING = 8;

/**
 * 页面上一个路径（插件日志这种）：单击选择怎么打开，⌘ / Ctrl 点击直接进编辑器。
 *
 * 手感与对话区里的路径链接（`apps/desktop` 的 `PathToken`）一致——同一个应用里点两处
 * 路径不该是两种行为。但这里只在配置页跑，两个动作都由宿主提供：`revealPath` 交给
 * 系统文件管理器，`openPathInEditor` 交给宿主自己的编辑器。宿主没有哪个能力，就少哪个
 * 选项；两样都没有（浏览器宿主）时这段文字退回纯文本——点了没反应比不可点更糟。
 *
 * 浮层用 `position: fixed` + 视口坐标：这一行是单行省略号（`overflow: hidden`），
 * 相对定位的弹层会被裁掉。
 */
export function PathLink({ path, text }: { path: string; text?: string }) {
  const [menu, setMenu] = useState<{ left: number; top: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const rootRef = useRef<HTMLSpanElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const FolderIcon = appIcons.folder;
  const EditorIcon = appIcons.config;

  const actions: PathMenuAction[] = [];
  if (supportsPathReveal()) {
    actions.push({
      key: 'reveal',
      label: '在 Finder 中打开',
      Icon: FolderIcon,
      run: () => revealPath(path),
    });
  }
  if (supportsPathEditor()) {
    actions.push({
      key: 'editor',
      label: '在 Mica 中打开',
      Icon: EditorIcon,
      run: () => openPathInEditor(path),
    });
  }
  const open = menu !== null;

  // 浮层贴着触发点，但不许出横竖边界：这一行常在页面右半边的信息栏里。
  useEffect(() => {
    if (!open) return;
    function close() {
      setMenu(null);
      setError(null);
    }
    function onPointerDown(event: MouseEvent) {
      if (rootRef.current?.contains(event.target as Node)) return;
      close();
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') close();
    }
    // 页面一滚，定死的视口坐标就与那一行脱开了：直接收起，比跟着乱飘诚实。
    document.addEventListener('mousedown', onPointerDown, true);
    document.addEventListener('keydown', onKeyDown);
    window.addEventListener('scroll', close, true);
    window.addEventListener('resize', close);
    return () => {
      document.removeEventListener('mousedown', onPointerDown, true);
      document.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('scroll', close, true);
      window.removeEventListener('resize', close);
    };
  }, [open]);

  if (actions.length === 0) return <>{text ?? path}</>;
  const editorAction = actions.find((action) => action.key === 'editor');

  function openMenu() {
    const rect = triggerRef.current?.getBoundingClientRect();
    if (!rect) return;
    const height = actions.length * MENU_ITEM_HEIGHT + MENU_PADDING;
    setError(null);
    setMenu({
      left: Math.max(8, Math.min(rect.left, window.innerWidth - MENU_WIDTH - 8)),
      // 底下放不下就翻到上面：这一行常常贴在页面底部。
      top:
        rect.bottom + 4 + height > window.innerHeight
          ? Math.max(8, rect.top - 4 - height)
          : rect.bottom + 4,
    });
  }

  async function run(action: PathMenuAction) {
    if (pending) return;
    setPending(true);
    try {
      const result = await action.run();
      if (result?.ok === false) {
        // 打不开就把原因留在原处（日志文件今天还没写是最常见的一种），
        // 关掉浮层只会让人以为点了没反应。
        openMenu();
        setError(result.error || '打不开这个路径');
        return;
      }
      setMenu(null);
      setError(null);
    } catch (runError) {
      setError(runError instanceof Error ? runError.message : String(runError));
    } finally {
      setPending(false);
    }
  }

  return (
    <span className="path-link-wrap" ref={rootRef}>
      <button
        ref={triggerRef}
        type="button"
        className="path-link"
        title={editorAction ? `${path}\n单击选择打开方式，⌘ / Ctrl 点击直接在 Mica 中打开` : `${path}\n单击选择打开方式`}
        onClick={(event) => {
          if ((event.metaKey || event.ctrlKey) && editorAction) {
            void run(editorAction);
            return;
          }
          if (open) {
            setMenu(null);
            setError(null);
            return;
          }
          openMenu();
        }}
        onContextMenu={(event) => {
          // 右键也给同一份选择，和对话区路径一致
          event.preventDefault();
          openMenu();
        }}
      >
        {text ?? path}
      </button>
      {menu ? (
        <div
          className="path-menu"
          role="menu"
          style={{ left: menu.left, top: menu.top, width: MENU_WIDTH }}
        >
          {error ? <div className="path-menu-error">{error}</div> : null}
          {actions.map((action) => (
            <button
              key={action.key}
              type="button"
              role="menuitem"
              className="path-menu-item"
              disabled={pending}
              onClick={() => void run(action)}
            >
              <action.Icon size={14} aria-hidden="true" />
              <span>{action.label}</span>
            </button>
          ))}
        </div>
      ) : null}
    </span>
  );
}
