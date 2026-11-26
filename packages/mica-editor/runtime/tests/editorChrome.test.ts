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
const blockSource = readSource('src/playground/plugins/DraggableBlockPlugin/index.tsx');
const blockMenuSource = readSource('src/playground/plugins/DraggableBlockPlugin/BlockMenu.tsx');
const blockActionsSource = readSource('src/playground/plugins/DraggableBlockPlugin/blockMenuActions.ts');
const blockStyles = readSource('src/playground/plugins/DraggableBlockPlugin/index.css');
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
  });

  it('keeps the Yuque-style block handle and action menu contract', () => {
    expect(blockSource).toContain('className="mica-block-handle"');
    expect(blockSource).toContain('data-block-handle');
    expect(blockMenuSource).toContain('可拖拽和点击');
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
    expect(blockStyles).toContain('border-radius: 8px;');
    expect(blockStyles).toContain("data-block-action='delete'");
    expect(blockStyles).toContain('color: var(--mica-arco-text);');

    expect(blockSource).toContain('protectFirstBlock');
    expect(blockActionsSource).toContain('$isHeadingNode(node)');
    expect(blockActionsSource).toContain("node.getTag() === 'h1'");
    expect(blockActionsSource).toContain('root.getFirstChild()');
  });

  it('does not reserve the table toolbar as an empty document row', () => {
    expect(notebookDocumentStyles).toContain('margin: 4px 0 16px;');
    expect(notebookWorkbenchStyles).not.toContain('margin: 8px 0 24px;');
  });

  it('pins the measured Yuque document and host geometry', () => {
    expect(notebookDocumentStyles).toContain('--notebook-page-width: 850px;');
    expect(notebookDocumentStyles).toContain('--notebook-body-gutter: 50px;');
    expect(notebookDocumentStyles).toContain('--notebook-body-top: 24px;');
    expect(notebookDocumentStyles).toContain("'Chinese Quote', -apple-system, BlinkMacSystemFont");
    expect(notebookDocumentStyles).toContain('font-size: var(--notebook-body-size);');
    expect(notebookDocumentStyles).toContain('height: 33px;');
    expect(notebookDocumentStyles).toContain('padding: 3px 8px;');
    expect(notebookHostStyles).toContain('--notebook-bar-height: 52px;');
    expect(notebookHostStyles).toContain('--notebook-outline-width: 305px;');
    expect(notebookHostStyles).toContain('--notebook-row-height: 36px;');
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
  });

  it('keeps a portal submenu open while the pointer crosses into it', () => {
    expect(blockMenuSource).toContain('scheduleSubmenuClose');
    expect(blockMenuSource).toContain('cancelSubmenuClose');
    expect(blockMenuSource).toContain('onMouseEnter={cancelSubmenuClose}');
    expect(blockMenuSource).toContain('[role="menuitem"]:not([aria-disabled="true"])');
    expect(blockMenuSource).toContain('Scrolling a long submenu must not dismiss the menu stack');
  });

  it('keeps narrow table controls reachable instead of clipping their action row', () => {
    const tableControlsStyles = readSource('src/playground/plugins/TableControlsPlugin/index.css');
    expect(tableControlsStyles).toContain('overflow-x: auto;');
    expect(tableControlsStyles).toContain('.table-context-toolbar > * { flex: none; }');
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
