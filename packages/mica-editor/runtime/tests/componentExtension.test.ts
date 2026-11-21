import { createHeadlessEditor } from '@lexical/headless';
import { HeadingNode } from '@lexical/rich-text';
import { $createParagraphNode, $createTextNode, $getRoot } from 'lexical';
import { describe, expect, it } from 'vitest';

import { DEFAULT_COMPONENT_BLOCK, insertComponentBlock } from '../src/playground/plugins/ComponentExtension';
import { ComponentNode, buildComponentDocument } from '../src/playground/nodes/ComponentNode';

const THEME = {
  dark: false,
  background: '#ffffff',
  foreground: '#20232a',
  border: '#e3e6ea',
  fontFamily: 'system-ui, sans-serif',
};

function createEditor() {
  return createHeadlessEditor({
    namespace: 'component-extension-test',
    nodes: [HeadingNode, ComponentNode],
    onError(error) {
      throw error;
    },
  });
}

describe('Notebook component blocks', () => {
  it('inserts a component block as its own node type, not an html block', () => {
    const editor = createEditor();
    editor.update(
      () => {
        const paragraph = $createParagraphNode().append($createTextNode('前文'));
        $getRoot().append(paragraph);
        paragraph.selectEnd();
      },
      { discrete: true },
    );

    insertComponentBlock(editor, { code: 'function App() { return null; }' });

    editor.getEditorState().read(() => {
      expect(
        $getRoot()
          .getChildren()
          .map((node) => node.getType()),
      ).toEqual(['paragraph', 'component', 'paragraph']);
      const block = $getRoot().getChildren()[1];
      expect(block instanceof ComponentNode && block.getCode()).toBe('function App() { return null; }');
    });
  });

  it('serializes the source under code and reads it back', () => {
    const editor = createEditor();
    insertComponentBlock(editor, { code: DEFAULT_COMPONENT_BLOCK });
    const json = editor
      .getEditorState()
      .toJSON()
      .root.children.find((node) => node.type === 'component');
    expect(json).toMatchObject({ type: 'component' });
    expect((json as { code?: string }).code).toBe(DEFAULT_COMPONENT_BLOCK);
    expect(json).not.toHaveProperty('html');
    expect(json).not.toHaveProperty('runtime');
  });

  it('imports a serialized component node back into the editor', () => {
    const editor = createEditor();
    editor.setEditorState(
      editor.parseEditorState(
        JSON.stringify({
          root: {
            type: 'root',
            version: 1,
            direction: null,
            format: '',
            indent: 0,
            children: [
              {
                type: 'component',
                code: 'function App() { return null; }',
                version: 1,
                direction: null,
                format: '',
                indent: 0,
              },
              { type: 'paragraph', version: 1, direction: null, format: '', indent: 0, children: [] },
            ],
          },
        }),
      ),
    );
    editor.getEditorState().read(() => {
      const block = $getRoot().getChildren()[0];
      expect(block).toBeInstanceOf(ComponentNode);
      expect(block instanceof ComponentNode && block.getCode()).toBe('function App() { return null; }');
    });
  });

  it('keeps the short React/Arco template executable as block source', () => {
    expect(DEFAULT_COMPONENT_BLOCK).toContain('function App({React, Arco, html})');
    expect(DEFAULT_COMPONENT_BLOCK).toContain('<${Card}');
    expect(DEFAULT_COMPONENT_BLOCK).toContain('setCount(count + 1)');
  });

  it('pins React + Arco and escapes a script terminator in the source', () => {
    const document = buildComponentDocument('const x = "</script>";', THEME);
    expect(document).toContain('esm.sh/react@18.3.1');
    expect(document).toContain('@arco-design/web-react@2.66.18');
    expect(document).toContain('mica-block-height');
    expect(document).toContain('<\\/script>');
  });

  it('switches Arco tokens with the host appearance inside the frame', () => {
    expect(buildComponentDocument('function App() { return null; }', THEME)).not.toContain('arco-theme="dark"');
    expect(buildComponentDocument('function App() { return null; }', { ...THEME, dark: true })).toContain(
      '<body arco-theme="dark">',
    );
  });

  it('gives search and copy the block source as its text', () => {
    const editor = createEditor();
    insertComponentBlock(editor, { code: 'function App() { return 1; }' });
    editor.getEditorState().read(() => {
      const block = $getRoot()
        .getChildren()
        .find((node) => node.getType() === 'component') as ComponentNode;
      expect(block.getTextContent()).toBe('function App() { return 1; }');
    });
  });
});
