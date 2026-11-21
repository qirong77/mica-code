/**
 * A block that renders user HTML inside a sandboxed iframe.
 *
 * Only static HTML lives here: interactive React + Arco prototypes are their
 * own block type (`ComponentNode`), so a note never has to guess which runtime
 * an `html` node wanted.
 */

import type {JSX} from 'react';

import {BlockWithAlignableContents} from '@lexical/react/LexicalBlockWithAlignableContents';
import {DecoratorBlockNode, type SerializedDecoratorBlockNode} from '@lexical/react/LexicalDecoratorBlockNode';
import {
  $getDocument,
  $getNodeByKey,
  type DOMExportOutput,
  type EditorConfig,
  type ElementFormatType,
  type LexicalEditor,
  type LexicalNode,
  type NodeKey,
  nodeSchema,
  numberValue,
  optional,
  type Spread,
  stringValue,
  withAccessors,
} from 'lexical';
import * as React from 'react';

import {SandboxBlock, blockDocument, stripTags, useBlockTheme} from './sandboxBlock';

const htmlNodeSchema = nodeSchema<HtmlNode>()({
  html: withAccessors(stringValue(), {getter: {field: '__html'}}),
  height: withAccessors(optional(numberValue()), {getter: 'getHeight'}),
});

type HtmlBlockProps = Readonly<{
  className: Readonly<{base: string; focus: string}>;
  format: ElementFormatType | null;
  nodeKey: NodeKey;
  editor: LexicalEditor;
  html: string;
  height?: number;
}>;

function HtmlBlockComponent({className, format, nodeKey, editor, html, height}: HtmlBlockProps): JSX.Element {
  const anchorRef = React.useRef<HTMLDivElement>(null);
  const theme = useBlockTheme(anchorRef);
  const source = React.useMemo(() => blockDocument(theme, {body: html}), [html, theme]);

  return (
    <BlockWithAlignableContents className={className} format={format} nodeKey={nodeKey}>
      <div ref={anchorRef} style={{position: 'relative', width: '100%'}}>
        <SandboxBlock
          document={source}
          editLabel="编辑 HTML"
          frameTitle="HTML 块"
          height={height}
          onSave={next => {
            editor.update(() => {
              const node = $getNodeByKey(nodeKey);
              if (node instanceof HtmlNode) node.setHtml(next);
            });
          }}
          source={html}
        />
      </div>
    </BlockWithAlignableContents>
  );
}

export type SerializedHtmlNode = Spread<
  {
    html: string;
    height?: number;
  },
  SerializedDecoratorBlockNode
>;

export class HtmlNode extends DecoratorBlockNode {
  __html: string;
  __height?: number;

  $config() {
    return this.config('html', {
      extends: DecoratorBlockNode,
      json: htmlNodeSchema,
    });
  }

  static clone(node: HtmlNode): HtmlNode {
    return new HtmlNode(node.__html, node.__height, node.__format, node.__key);
  }

  constructor(html: string = '', height?: number, format?: ElementFormatType, key?: NodeKey) {
    super(format, key);
    this.__html = html;
    this.__height = height;
  }

  getHtml(): string {
    return this.getLatest().__html;
  }

  setHtml(html: string): this {
    const self = this.getWritable();
    self.__html = html;
    return self;
  }

  getHeight(): number | undefined {
    return this.getLatest().__height;
  }

  setHeight(height: number | undefined): this {
    const self = this.getWritable();
    self.__height = height;
    return self;
  }

  exportDOM(): DOMExportOutput {
    const element = $getDocument().createElement('div');
    element.setAttribute('data-lexical-html-block', 'true');
    element.textContent = this.__html;
    return {element};
  }

  updateDOM(): false {
    return false;
  }

  getTextContent(): string {
    return stripTags(this.__html);
  }

  isInline(): false {
    return false;
  }

  decorate(editor: LexicalEditor, config: EditorConfig): JSX.Element {
    const embedBlockTheme = config.theme.embedBlock || {};
    return (
      <HtmlBlockComponent
        className={{
          base: embedBlockTheme.base || '',
          focus: embedBlockTheme.focus || '',
        }}
        editor={editor}
        format={this.__format}
        height={this.__height}
        html={this.__html}
        nodeKey={this.getKey()}
      />
    );
  }
}

export function $createHtmlNode(html: string, height?: number): HtmlNode {
  return new HtmlNode(html, height);
}

export function $isHtmlNode(node: HtmlNode | LexicalNode | null | undefined): node is HtmlNode {
  return node instanceof HtmlNode;
}
