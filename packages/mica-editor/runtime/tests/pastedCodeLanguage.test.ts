// @vitest-environment happy-dom
import {$createCodeNode, $isCodeNode, CodeNode} from '@lexical/code';
import {createHeadlessEditor} from '@lexical/headless';
import {LinkNode} from '@lexical/link';
import {ListItemNode, ListNode} from '@lexical/list';
import {TRANSFORMERS} from '@lexical/markdown';
import {HeadingNode, QuoteNode} from '@lexical/rich-text';
import {$createParagraphNode, $getRoot, PASTE_COMMAND} from 'lexical';
import {describe, expect, it, vi} from 'vitest';

import {CODE_LANGUAGE_SAMPLE_LIMIT, detectPastedCodeLanguage} from '../src/playground/plugins/MarkdownPastePlugin/codeLanguage';
import {applyMarkdownPaste, registerMarkdownPaste, type MarkdownPasteSpan} from '../src/playground/plugins/MarkdownPastePlugin/markdownPaste';

const PYTHON = 'def greet(name):\n    print(f"Hello {name}")';
const GO = 'package main\n\nimport "fmt"\n\nfunc main() {\n    fmt.Println("Hello")\n}';
const JS = 'const greet = (name) => {\n  console.log(name);\n};';

describe('bounded code language detection', () => {
  it.each([
    [JS, 'js'],
    ['export async function load() { return await fetch("/api"); }', 'js'],
    [PYTHON, 'py'],
    ['from pathlib import Path\nfor file in Path(".").iterdir():\n    print(file)', 'py'],
    [GO, 'go'],
    ['func (s *Server) Serve() error {\n return nil\n}', 'go'],
    ['interface User { name: string; }', 'typescript'],
    ['const count: number = 1;', 'typescript'],
    ['SELECT id, name FROM users WHERE active = true;', 'sql'],
  ])('recognizes a common source snippet', (source, language) => {
    expect(detectPastedCodeLanguage(source)).toBe(language);
  });

  it.each(['普通说明文字', '# 标题\n\n- 列表', 'a\tb\n1\t2', 'x = 1', 'Use the function to load a package.'])('leaves ambiguous prose and data alone', source => {
    expect(detectPastedCodeLanguage(source)).toBeNull();
  });

  it('does not scan past the fixed sample limit', () => {
    expect(detectPastedCodeLanguage(' '.repeat(CODE_LANGUAGE_SAMPLE_LIMIT) + PYTHON)).toBeNull();
  });
});

function fixture(codeLanguage?: string | null) {
  const editor = createHeadlessEditor({
    namespace: 'pasted-code-language',
    nodes: [CodeNode, HeadingNode, QuoteNode, ListNode, ListItemNode, LinkNode],
    onError(error) { throw error; },
  });
  const spans: MarkdownPasteSpan[] = [];
  registerMarkdownPaste(editor, TRANSFORMERS, span => spans.push(span));
  editor.update(() => {
    const block = codeLanguage === undefined ? $createParagraphNode() : $createCodeNode(codeLanguage || undefined);
    $getRoot().append(block);
    block.selectEnd();
  }, {discrete: true});
  return {
    editor, spans,
    paste(text: string, html?: string) {
      const data: Record<string, string> = {'text/plain': text};
      if (html) data['text/html'] = html;
      editor.update(() => {
        editor.dispatchCommand(PASTE_COMMAND, {
          clipboardData: {types: Object.keys(data), files: [], getData: (type: string) => data[type] || ''},
          preventDefault: vi.fn(),
        } as unknown as ClipboardEvent);
      }, {discrete: true});
    },
    language: () => editor.getEditorState().read(() => {
      const code = $getRoot().getFirstChild();
      return $isCodeNode(code) ? code.getLanguage() : null;
    }),
  };
}

describe('code languages during paste', () => {
  it('pastes plain code directly into a named code block', () => {
    const f = fixture();
    f.paste(GO);
    expect(f.language()).toBe('go');
    expect(f.spans).toHaveLength(0);
  });

  it('infers an unlabelled Markdown fence only when it is converted', async () => {
    const f = fixture();
    f.paste('```\n' + PYTHON + '\n```');
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(f.language()).toBeNull();
    expect(f.spans).toHaveLength(1);
    expect(applyMarkdownPaste(f.editor, f.spans[0], TRANSFORMERS)).toBe(true);
    expect(f.language()).toBe('py');
  });

  it('preserves an explicit Markdown language even when keywords disagree', async () => {
    const f = fixture();
    f.paste('```javascript\n' + PYTHON + '\n```');
    await new Promise(resolve => setTimeout(resolve, 0));
    applyMarkdownPaste(f.editor, f.spans[0], TRANSFORMERS);
    expect(f.language()).toBe('javascript');
  });

  it('sets an unset code block language without consuming its native paste', () => {
    const f = fixture(null);
    f.paste(JS);
    expect(f.language()).toBe('js');
  });

  it('keeps a code block language chosen by the reader', () => {
    const f = fixture('go');
    f.paste(PYTHON);
    expect(f.language()).toBe('go');
  });

  it('infers an isolated HTML code clipboard and preserves its content', () => {
    const f = fixture();
    f.paste(PYTHON, '<pre><code>' + PYTHON + '</code></pre>');
    expect(f.language()).toBe('py');
    expect(f.editor.getEditorState().read(() => $getRoot().getTextContent())).toBe(PYTHON);
  });

  it('uses an explicit HTML code language before guessing', () => {
    const f = fixture();
    f.paste(PYTHON, '<pre><code class="language-go">' + PYTHON + '</code></pre>');
    expect(f.language()).toBe('go');
  });
});
