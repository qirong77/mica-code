import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {describe, expect, it} from 'vitest';

const readSource = (path: string) => readFileSync(resolve(process.cwd(), path), 'utf8');
const markdownStyles = readSource('src/markdown/markdown.css');
const linkSource = readSource('src/playground/plugins/FloatingLinkEditorPlugin/index.tsx');
const linkStyles = readSource('src/playground/plugins/FloatingLinkEditorPlugin/index.css');
const notebookStyles = readSource('src/workspace/notebook.css');
const notebookWorkbenchStyles = readSource('src/workspace/notebook-workbench.css');
const notebookDocumentStyles = readSource('src/workspace/notebook-document.css');
const notebookHostStyles = readSource('../../../plugins/notebook/notebook.css');
const notebookDesktopSource = readSource('../../../plugins/notebook/desktop.jsx');
const blockSource = readSource('src/playground/plugins/DraggableBlockPlugin/index.tsx');
const blockMenuSource = readSource('src/playground/plugins/DraggableBlockPlugin/BlockMenu.tsx');
const blockActionsSource = readSource('src/playground/plugins/DraggableBlockPlugin/blockMenuActions.ts');
const blockStyles = readSource('src/playground/plugins/DraggableBlockPlugin/index.css');
const blockIcon = readSource('src/playground/images/icons/draggable-block-menu.svg');
const editorSource = readSource('src/playground/Editor.tsx');
const notebookBridgeSource = readSource('src/workspace/NotebookBridge.tsx');
const notebookHostBridgeSource = readSource('../../../plugins/notebook/bridge.ts');

describe('editor chrome style contracts', () => {
  it('keeps link previews compact with Yuque-style edit and remove actions', () => {
    expect(linkSource).toContain("mica-config-ui/web/components/Ui");
    expect(linkSource).toContain('className="mica-link-editor__preview"');
    expect(linkSource).toContain('className="mica-link-editor__preview-row"');
    expect(linkSource).toContain('className="mica-link-editor__icon is-edit"');
    expect(linkSource).toContain('className="mica-link-editor__icon is-remove"');
    expect(linkSource).toContain('aria-label="编辑链接"');
    expect(linkSource).toContain('aria-label="移除链接"');
    expect(linkSource).toContain('variant="accent" onClick={submit}');
    expect(linkStyles).toContain('flex-direction: column;');
    expect(linkStyles).toContain('text-overflow: ellipsis;');
    expect(linkStyles).toContain('.mica-link-editor__preview-row');
    expect(linkStyles).toContain('.link-editor.mica-link-editor[hidden]');
  });

  it('does not replace expanded table actions with the neutral hover state', () => {
    expect(notebookStyles).toContain(".table-context-toolbar .arco-btn:hover:not(.arco-btn-disabled):not([aria-expanded='true']):not([aria-pressed='true'])");
    expect(notebookStyles).toContain('background: var(--color-active)');
  });

  it('keeps selected image and table settings out of ordinary portal action styles', () => {
    expect(notebookStyles).toContain(":not([aria-pressed='true']):not([aria-expanded='true']) { color: var(--color-fg-soft); }");
    expect(notebookStyles).toContain(":not([aria-pressed='true']):not([aria-expanded='true']):hover");
  });

  it('aligns compact controls and labels without changing document content rules', () => {
    expect(notebookStyles).toContain('.ruby-editor .button { display: inline-flex;');
    expect(notebookStyles).toContain('width: 28px; height: 28px;');
    expect(markdownStyles).toContain('height: 28px; min-width: 28px;');
    expect(notebookStyles).toContain('.ruby-editor :is(.button, .ruby-input):focus-visible');
    expect(notebookStyles).toContain('.image-settings-popover .Input__wrapper { display: flex; flex-direction: column; gap: 6px; }');
    expect(notebookStyles).toContain('body:has(.notebook-editor)');
    expect(notebookStyles).toContain("body[data-notebook-style='open'] :is(.table-selection-handles, .table-scroll-fades, .table-context-toolbar, .table-control-popup)");
  });

  it('keeps the Yuque-style block handle and action menu contract', () => {
    expect(blockSource).toContain('className="mica-block-handle"');
    expect(blockSource).toContain('data-block-handle');
    // 语雀的提示拆成四段：可 / 拖拽 / 和 / 点击，奇偶序号分别用灰、白两种字色。
    for (const word of ['可', '拖拽', '和', '点击']) {
      expect(blockMenuSource).toContain(`<span>${word}</span>`);
    }
    expect(blockStyles).toContain('.mica-block-handle__hint > span:nth-child(odd)');
    expect(blockStyles).toContain('var(--block-hint-left, -8px)');
    expect(blockSource).toContain('--block-hint-left');
    expect(blockStyles).toContain("html[data-appearance='dark'] .mica-block-handle__hint");
    // 握把图标取自语雀 larkui-icon-drag（六点，viewBox 256）。
    expect(blockIcon).toContain('viewBox="0 0 256 256"');
    expect(blockIcon).toContain('M88 187c9.941 0 18 8.059 18 18s-8.059 18-18 18');
    expect(blockSource).toContain('CLICK_SLOP');

    expect(blockMenuSource).toContain('className="mica-block-menu"');
    // Rows without a submenu are literals; the three with one come from
    // `submenuRow(kind, …)`, which carries the same attribute.
    for (const action of ['turn-into', 'indent', 'insert-below']) {
      expect(blockMenuSource).toContain(`submenuRow('${action}'`);
    }
    expect(blockMenuSource).toContain('data-block-action={kind}');
    for (const action of ['delete', 'copy', 'cut']) {
      expect(blockMenuSource).toContain(`data-block-action="${action}"`);
    }
    expect(blockMenuSource.match(/<MenuSeparator\s*\/?\s*>/g)).toHaveLength(3);
    expect(blockMenuSource).toContain('is-submenu');
    expect(blockMenuSource).toContain('data-block-action={`turn-${item.shape}`}');
    for (const shape of ['paragraph', 'h2', 'h3', 'bullet', 'number', 'quote', 'code']) {
      expect(blockMenuSource).toContain(`shape: '${shape}'`);
    }
    for (const action of ['indent-in', 'indent-out']) {
      expect(blockMenuSource).toContain(`data-block-action="${action}"`);
    }

    expect(blockStyles).toContain('min-width: 180px;');
    expect(blockStyles).toContain('padding: 8px;');
    expect(blockStyles).toContain('height: 36px;');
    expect(blockStyles).toContain('font-size: 14px;');
    // 语雀的块菜单面板是 6px 圆角（`.ant-menu-submenu-popup.ne-brick-menu`），
    // 菜单项也是 6px；不要再回到 8。
    expect(blockStyles).toContain('border-radius: 6px;');
    expect(blockStyles).toContain("data-block-action='delete'");
    // 菜单颜色只认编辑器自己的 token：宿主换主题不应该带着块菜单一起变色。
    expect(blockStyles).toContain('color: var(--notebook-text-primary);');
    expect(blockStyles).not.toContain('var(--mica-arco-');

    expect(blockSource).toContain('protectFirstBlock');
    expect(blockActionsSource).toContain('$isHeadingNode(node)');
    expect(blockActionsSource).toContain("node.getTag() === 'h1'");
    expect(blockActionsSource).toContain('root.getFirstChild()');
  });

  it('does not reserve the table toolbar as an empty document row', () => {
    expect(notebookDocumentStyles).toContain('margin: 4px 0 16px;');
    expect(notebookDocumentStyles).toContain('padding-top: 14px;');
    expect(notebookWorkbenchStyles).not.toContain('margin: 8px 0 24px;');
  });

  it('pins the measured Yuque document and host geometry', () => {
    expect(notebookDocumentStyles).toContain('--notebook-page-width: 850px;');
    expect(notebookDocumentStyles).toContain('--notebook-body-gutter: 50px;');
    expect(notebookDocumentStyles).toContain('--notebook-body-top: 24px;');
    // 语雀把阅读列钉在大纲一侧，宽窗口多出来的留白落在左边。
    expect(notebookDocumentStyles).toContain('margin-inline: auto 0;');
    // 只有手机收窄留白；桌面上的编辑列再挤也要留住 50px gutter。
    expect(notebookDocumentStyles).toContain('@media (max-width: 480px)');
    expect(notebookDocumentStyles).not.toContain('@media (max-width: 600px)');
    expect(notebookDocumentStyles).toContain("'Chinese Quote', -apple-system, BlinkMacSystemFont");
    expect(notebookDocumentStyles).toContain('letter-spacing: .008em;');
    expect(notebookDocumentStyles).toContain('margin: 26px 0 10px;');
    expect(notebookDocumentStyles).toContain('font-size: var(--notebook-body-size);');
    expect(notebookDocumentStyles).toContain('height: 33px;');
    expect(notebookDocumentStyles).toContain('line-height: 24px;');
    expect(notebookDocumentStyles).toContain('padding: 4px 8px;');
    expect(notebookHostStyles).toContain('--notebook-bar-height: 52px;');
    expect(notebookHostStyles).toContain('--notebook-outline-width: 305px;');
    expect(notebookHostStyles).toContain('--notebook-row-height: 36px;');
    expect(notebookHostStyles).toContain('height: calc(var(--notebook-row-height) - 2px);');
    expect(notebookHostStyles).toContain('background: transparent;');
  });

  it('keeps the Notebook palette independent from the surrounding Mica accent', () => {
    for (const value of [
      '--notebook-bg-primary: #fff;',
      '--notebook-bg-secondary: #fafafa;',
      '--notebook-bg-tertiary: #f4f5f5;',
      '--notebook-bg-hover: #eff0f0;',
      '--notebook-border-primary: #e7e9e8;',
      '--notebook-text-primary: #262626;',
      '--notebook-text-body: #585a5a;',
      '--notebook-text-caption: #8a8f8d;',
      '--notebook-accent: #00b96b;',
      '--notebook-link: #117cee;',
    ]) {
      expect(notebookHostStyles).toContain(value);
      expect(notebookStyles).toContain(value);
    }
    for (const value of [
      '--notebook-bg-primary: #141414;',
      '--notebook-bg-secondary: #1f1f1f;',
      '--notebook-bg-tertiary: rgb(255 255 255 / 4%);',
      '--notebook-border-primary: rgb(255 255 255 / 12%);',
      '--notebook-text-primary: #e2e2e2;',
      '--notebook-text-body: #b3b3b3;',
      '--notebook-text-caption: #848484;',
      '--notebook-accent: #2ed790;',
      '--notebook-link: #3b82ce;',
    ]) {
      expect(notebookHostStyles).toContain(value);
      expect(notebookStyles).toContain(value);
    }
    expect(notebookDesktopSource).toContain("'has-children'");
    expect(notebookHostStyles).not.toContain('--notebook-outline-width: 240px;');
  });

  it('keeps the notebook header on Yuque’s 10 / 4 / 10 rhythm', () => {
    // 书名列在 10px 内距里再缩 4px：图标 14、书名 44，收起按钮留在同一行。
    expect(notebookHostStyles).toContain('padding: 0 10px 12px;');
    expect(notebookHostStyles).toContain('padding-inline-start: 4px;');
    expect(notebookHostStyles).toContain('font-weight: 700;');
    expect(notebookHostStyles).toContain('.notebook-page .notebook-rail-collapse');
    expect(notebookHostStyles).toContain('margin: 0 0 0 8px;');
    // 收起按钮不能再绝对定位压在「N 篇笔记」上。
    expect(notebookHostStyles).not.toContain('.notebook-rail-title > .ui-button');
    expect(notebookDesktopSource).toMatch(/notebook-book-info[\s\S]*notebook-rail-collapse/);
  });

  it('reveals the block handle on block hover, in panes narrower than the toolbar breakpoint', () => {
    // Hovering the block (not the invisible handle) has to reveal the grip.
    expect(blockStyles).toContain('.draggable-block-menu.is-visible,');
    expect(blockSource).toContain("draggableElement ? ' is-visible' : ''");
    // The notebook hosts this editor in a pane that is usually < 1025px.
    expect(editorSource).toContain("window.matchMedia('(hover: hover) and (pointer: fine)')");
    expect(editorSource).toContain('floatingAnchorElem && canUseBlockHandle &&');
    // The measured 50px reading gutter remains stable while both host panels
    // are open; the block handle is positioned inside that gutter.
    expect(notebookDocumentStyles).toContain('--notebook-body-gutter: 50px;');
    expect(notebookDocumentStyles).not.toContain('--notebook-body-gutter: 32px;');
    // 握把是语雀那枚 24px 圆角按钮：页面底色 + 正文色，16px 图标离正文 2px，
    // 再抵消 Lexical 固定加的 4px。
    expect(blockSource).toContain('const BLOCK_HANDLE_TEXT_GAP = 2;');
    expect(blockSource).toContain('const BLOCK_HANDLE_LEXICAL_OFFSET = 4;');
    expect(blockStyles).toContain('background: var(--notebook-bg-primary);');
    expect(blockStyles).toContain('opacity: .88;');
  });

  it('keeps a portal submenu open while the pointer crosses into it', () => {
    expect(blockMenuSource).toContain('scheduleSubmenuClose');
    expect(blockMenuSource).toContain('cancelSubmenuClose');
    expect(blockMenuSource).toContain('onMouseEnter={cancelSubmenuClose}');
    expect(blockMenuSource).toContain('[role="menuitem"]:not([aria-disabled="true"])');
    expect(blockMenuSource).toContain('Scrolling a long submenu must not dismiss the menu stack');
    expect(blockSource).toContain('previousMenu');
    expect(blockSource).toContain('editor.getRootElement()?.focus({preventScroll: true})');
  });

  it('keeps narrow table controls reachable instead of clipping their action row', () => {
    const tableControlsStyles = readSource('src/playground/plugins/TableControlsPlugin/index.css');
    const tableHandlesSource = readSource('src/playground/plugins/TableControlsPlugin/TableSelectionHandles.tsx');
    const tableControlsSource = readSource('src/playground/plugins/TableControlsPlugin/index.tsx');
    expect(tableControlsStyles).toContain('overflow-x: auto;');
    expect(tableControlsStyles).toContain('.table-context-toolbar > * { flex: none; }');
    expect(tableControlsSource).toContain('whileElementsMounted: autoUpdate');
    expect(tableControlsSource).toContain('new MutationObserver(closeWhenStylePanelOpens)');
    expect(tableControlsSource).toContain('queueMicrotask(() => menu.refs.floating.current');
    expect(tableHandlesSource).toContain('const RAIL_SIZE = 14;');
    expect(tableHandlesSource).toContain('const RAIL_OFFSET = 13;');
  });

  it('clears the insert placeholder after the inserted block commits', () => {
    expect(blockSource).toContain('placeholderKey');
    expect(blockSource).toContain('placeholder.getChildrenSize() <= 1');
    expect(blockSource).toContain('placeholder.remove()');
  });

  it('asks the notebook host to write the clipboard for block copy and cut', () => {
    expect(blockSource).toContain('useNotebookSession');
    expect(blockSource).toContain('notebookSession.copyBlock(');
    expect(blockSource).toContain('$generateHtmlFromNodes(editor, selection)');
    expect(blockSource).toContain('if (!ok) return;');
    expect(notebookBridgeSource).toContain('copyBlock(html: string, text: string)');
    expect(notebookBridgeSource).toContain("message.type === 'clipboardResult'");
    expect(notebookHostBridgeSource).toContain("data.type === 'clipboard'");
    expect(notebookHostBridgeSource).toContain('navigator.clipboard.write');
  });
});
