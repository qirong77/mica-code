/**
 * A block that runs a small React + Arco component inside a sandboxed iframe.
 *
 * The block is its own node type (`component`) instead of a runtime flag on the
 * static HTML block: it has different source (a module body, not markup), its
 * own pinned dependency versions and its own failure mode, and the editor never
 * has to guess what an `html` node was meant to be.
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

import {SandboxBlock, blockDocument, escapeModuleSource, useBlockTheme} from './sandboxBlock';

const componentNodeSchema = nodeSchema<ComponentNode>()({
  code: withAccessors(stringValue(), {getter: {field: '__code'}}),
  height: withAccessors(optional(numberValue()), {getter: 'getHeight'}),
});

/** Pinned so a note keeps rendering the same way when a new major ships. */
const REACT_VERSION = '18.3.1';
const ARCO_VERSION = '2.66.18';
const HTM_VERSION = '3.1.1';

type BlockTheme = Parameters<typeof blockDocument>[0];

/**
 * The block body is a module script: React, react-dom, Arco and htm come from
 * esm.sh, so the note stays a few lines of readable code with no build step.
 */
export function buildComponentDocument(code: string, theme: BlockTheme): string {
  return blockDocument(theme, {
    style: '  #root { padding: 0; }',
    head: `<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/@arco-design/web-react@${ARCO_VERSION}/dist/css/arco.css">`,
    body: `<div id="root"><div style="opacity:.55;font-size:13px">正在加载 React / Arco…</div></div>
<script>
(function(){
  var showError=function(error){
    var root=document.getElementById('root');
    if(!root)return;
    var pre=document.createElement('pre');
    pre.style.cssText='color:#d4380d;white-space:pre-wrap;font:12.5px/1.6 ui-monospace,monospace';
    pre.textContent=String(error&&error.stack||error);
    root.replaceChildren(pre);
  };
  window.__micaComponentError=showError;
  addEventListener('error',function(event){
    var target=event.target;
    var isModuleScript=target&&target.tagName==='SCRIPT'&&target.type==='module';
    if(event.error||isModuleScript)showError(event.error||event.message||'组件模块加载失败');
  },true);
  addEventListener('unhandledrejection',function(event){showError(event.reason||'组件块存在未处理的异步错误')});
})();
</script>
<script type="module">
import React from 'https://esm.sh/react@${REACT_VERSION}';
import {createRoot} from 'https://esm.sh/react-dom@${REACT_VERSION}/client';
import * as Arco from 'https://esm.sh/@arco-design/web-react@${ARCO_VERSION}?deps=react@${REACT_VERSION},react-dom@${REACT_VERSION}';
import htm from 'https://esm.sh/htm@${HTM_VERSION}';
const html = htm.bind(React.createElement);
const showError = window.__micaComponentError;
function formatError(error) {
  return String((error && error.stack) || error);
}
class ComponentErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = {error: null};
  }
  static getDerivedStateFromError(error) {
    return {error};
  }
  componentDidCatch(error) {
    console.error('组件块渲染错误', error);
  }
  render() {
    if (this.state.error) {
      return html\`<pre style=\${{color:"#d4380d",whiteSpace:"pre-wrap",font:"12.5px/1.6 ui-monospace,monospace"}}>\${formatError(this.state.error)}</pre>\`;
    }
    return this.props.children;
  }
}
try {
${escapeModuleSource(code)}
  const component = typeof App === 'function' ? App : null;
  if (!component) throw new Error('组件块需要定义 function App(props) { ... }');
  createRoot(document.getElementById('root')).render(
    html\`<\${ComponentErrorBoundary}><\${component} React=\${React} Arco=\${Arco} html=\${html} /></\${ComponentErrorBoundary}>\`,
  );
} catch (error) {
  showError(formatError(error));
}
</script>`,
  });
}

type ComponentBlockProps = Readonly<{
  className: Readonly<{base: string; focus: string}>;
  format: ElementFormatType | null;
  nodeKey: NodeKey;
  editor: LexicalEditor;
  code: string;
  height?: number;
}>;

function ComponentBlock({className, format, nodeKey, editor, code, height}: ComponentBlockProps): JSX.Element {
  const anchorRef = React.useRef<HTMLDivElement>(null);
  const theme = useBlockTheme(anchorRef);
  const [editable, setEditable] = React.useState(() => editor.isEditable());
  const source = React.useMemo(() => buildComponentDocument(code, theme), [code]);

  React.useEffect(() => editor.registerEditableListener(setEditable), [editor]);

  return (
    <BlockWithAlignableContents className={className} format={format} nodeKey={nodeKey}>
      <div ref={anchorRef} style={{position: 'relative', width: '100%'}}>
        <SandboxBlock
          document={source}
          editLabel="编辑组件"
          frameTitle="组件块"
          height={height}
          editable={editable}
          onSave={next => {
            editor.update(() => {
              const node = $getNodeByKey(nodeKey);
              if (node instanceof ComponentNode) node.setCode(next);
            });
          }}
          source={code}
        />
      </div>
    </BlockWithAlignableContents>
  );
}

export type SerializedComponentNode = Spread<
  {
    code: string;
    height?: number;
  },
  SerializedDecoratorBlockNode
>;

export class ComponentNode extends DecoratorBlockNode {
  __code: string;
  __height?: number;

  $config() {
    return this.config('component', {
      extends: DecoratorBlockNode,
      json: componentNodeSchema,
    });
  }

  static clone(node: ComponentNode): ComponentNode {
    return new ComponentNode(node.__code, node.__height, node.__format, node.__key);
  }

  constructor(code: string = '', height?: number, format?: ElementFormatType, key?: NodeKey) {
    super(format, key);
    this.__code = code;
    this.__height = height;
  }

  getCode(): string {
    return this.getLatest().__code;
  }

  setCode(code: string): this {
    const self = this.getWritable();
    self.__code = code;
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
    element.setAttribute('data-lexical-component-block', 'true');
    element.textContent = this.__code;
    return {element};
  }

  updateDOM(): false {
    return false;
  }

  /**
   * The source is the only textual form of the block, so search, copy and the
   * plain-text projection keep finding what the user wrote.
   */
  getTextContent(): string {
    return this.__code.trim();
  }

  isInline(): false {
    return false;
  }

  decorate(editor: LexicalEditor, config: EditorConfig): JSX.Element {
    const embedBlockTheme = config.theme.embedBlock || {};
    return (
      <ComponentBlock
        className={{
          base: embedBlockTheme.base || '',
          focus: embedBlockTheme.focus || '',
        }}
        code={this.__code}
        editor={editor}
        format={this.__format}
        height={this.__height}
        nodeKey={this.getKey()}
      />
    );
  }
}

export function $createComponentNode(code: string, height?: number): ComponentNode {
  return new ComponentNode(code, height);
}

export function $isComponentNode(node: ComponentNode | LexicalNode | null | undefined): node is ComponentNode {
  return node instanceof ComponentNode;
}
