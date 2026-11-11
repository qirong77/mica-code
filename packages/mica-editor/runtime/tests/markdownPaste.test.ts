import {createHeadlessEditor} from '@lexical/headless';
import {CodeNode, $createCodeNode} from '@lexical/code';
import {HeadingNode, QuoteNode} from '@lexical/rich-text';
import {ListNode, ListItemNode} from '@lexical/list';
import {LinkNode} from '@lexical/link';
import {TRANSFORMERS} from '@lexical/markdown';
import {$createParagraphNode, $createTextNode, $getRoot, PASTE_COMMAND} from 'lexical';
import {describe, expect, it, vi} from 'vitest';
import {isMarkdownText, registerMarkdownPaste} from '../src/playground/plugins/MarkdownPastePlugin/markdownPaste';

function paste(text: string, code = false, extra: Record<string,string> = {}, existing = '') {
  const editor = createHeadlessEditor({namespace:'markdown-test', nodes:[CodeNode, HeadingNode, QuoteNode, ListNode, ListItemNode, LinkNode], onError(e){throw e;}});
  registerMarkdownPaste(editor, TRANSFORMERS);
  const preventDefault = vi.fn();
  const data = {'text/plain':text, ...extra};
  let handled = false;
  editor.update(() => {
    const before = $createParagraphNode().append($createTextNode('保留原文'));
    const target = code ? $createCodeNode() : $createParagraphNode();
    if (existing) target.append($createTextNode(existing));
    $getRoot().append(before, target);
    target.selectEnd();
    handled = editor.dispatchCommand(PASTE_COMMAND, {clipboardData:{types:Object.keys(data), files:[], getData:(type:string)=>data[type as keyof typeof data] || ''}, preventDefault} as unknown as ClipboardEvent);
  }, {discrete:true});
  return {editor, handled, preventDefault};
}

describe('Markdown paste', () => {
  it('inserts headings and lists without replacing the document', () => {
    const {editor, handled, preventDefault} = paste('# 标题\n\n- 第一项\n- 第二项');
    expect(handled).toBe(true);
    expect(preventDefault).toHaveBeenCalled();
    editor.getEditorState().read(() => {
      const nodes=$getRoot().getChildren();
      expect(nodes[0].getTextContent()).toBe('保留原文');
      expect(nodes.map(n=>n.getType())).toEqual(['paragraph','heading','list']);
    });
  });
  it('converts inline formatting', () => {
    const {editor}=paste('这是 **重点**');
    expect(JSON.stringify(editor.getEditorState().toJSON())).toContain('重点');
    editor.getEditorState().read(()=>expect($getRoot().getLastChild()!.getTextContent()).toBe('这是 重点'));
  });
  it('preserves headings pasted after existing paragraph text', () => {
    const {editor}=paste('# 新标题\n\n正文', false, {}, '原段落');
    editor.getEditorState().read(()=> {
      expect($getRoot().getChildren().some(n=>n.getType()==='heading' && n.getTextContent()==='新标题')).toBe(true);
      expect($getRoot().getTextContent()).toContain('原段落');
    });
  });
  it('leaves source alone inside a code block', () => expect(paste('# 标题',true).handled).toBe(false));
  it('leaves ordinary prose alone', () => expect(paste('普通文字').handled).toBe(false));
  it('preserves internal Lexical clipboard', () => expect(paste('# 标题', false, {'application/x-lexical-editor':'{}'}).handled).toBe(false));
  it('accepts explicit Markdown MIME', () => expect(paste('普通文字', false, {'text/markdown':'普通文字'}).handled).toBe(true));
  it('does not reinterpret ordinary HTML', () => expect(paste('# 标题', false, {'text/html':'<h1>标题</h1>'}).handled).toBe(false));
  it('does not identify TSV or JavaScript as Markdown', () => {
    expect(isMarkdownText('a\tb\n1\t2')).toBe(false);
    expect(isMarkdownText('const x = 1;\nconsole.log(x);')).toBe(false);
  });
  it('keeps fenced code as a code node', () => {
    const {editor}=paste('```js\nconst x = 1;\n```');
    editor.getEditorState().read(()=>expect($getRoot().getLastChild()!.getType()).toBe('code'));
  });
});
