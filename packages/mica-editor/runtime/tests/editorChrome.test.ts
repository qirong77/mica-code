import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {describe, expect, it} from 'vitest';

const readSource = (path: string) => readFileSync(resolve(process.cwd(), path), 'utf8');
const markdownStyles = readSource('src/markdown/markdown.css');
const linkSource = readSource('src/playground/plugins/FloatingLinkEditorPlugin/index.tsx');
const linkStyles = readSource('src/playground/plugins/FloatingLinkEditorPlugin/index.css');
const notebookStyles = readSource('src/workspace/notebook.css');

describe('editor chrome style contracts', () => {
  it('keeps link previews in two rows with shared neutral and danger actions', () => {
    expect(linkSource).toContain("mica-config-ui/web/components/Ui");
    expect(linkSource).toContain('className="mica-link-editor__preview"');
    expect(linkSource).toContain('variant="ghost" size="compact" onClick={() => beginEditing(target)}');
    expect(linkSource).toContain('variant="danger-ghost" size="compact" onClick={remove}');
    expect(linkSource).toContain('variant="accent" onClick={submit}');
    expect(linkStyles).toContain('flex-direction: column;');
    expect(linkStyles).toContain('text-overflow: ellipsis;');
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
});
