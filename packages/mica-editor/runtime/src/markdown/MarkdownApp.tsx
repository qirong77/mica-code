import {Button, Radio, Select} from '@arco-design/web-react';
import {IconBold, IconItalic, IconLink, IconRedo, IconUndo} from '@arco-design/web-react/icon';
import {$createCodeNode, $isCodeNode} from '@lexical/code';
import {HorizontalRuleExtension, TabIndentationExtension} from '@lexical/extension';
import {HistoryExtension} from '@lexical/history';
import {LinkExtension, TOGGLE_LINK_COMMAND} from '@lexical/link';
import {CheckListExtension, ListExtension, INSERT_CHECK_LIST_COMMAND, INSERT_UNORDERED_LIST_COMMAND, INSERT_ORDERED_LIST_COMMAND} from '@lexical/list';
import {$generateNodesFromMarkdownString, registerMarkdownShortcuts} from '@lexical/markdown';
import {useLexicalComposerContext} from '@lexical/react/LexicalComposerContext';
import {LexicalExtensionComposer} from '@lexical/react/LexicalExtensionComposer';
import {$createHeadingNode, $createQuoteNode, $isHeadingNode, RichTextExtension} from '@lexical/rich-text';
import {$setBlocksType} from '@lexical/selection';
import {$getTableCellNodeFromLexicalNode, $isTableSelection, INSERT_TABLE_COMMAND, TableExtension} from '@lexical/table';
import {$addUpdateTag, $createParagraphNode, $getRoot, $getSelection, $isElementNode, $isRangeSelection, CAN_REDO_COMMAND, CAN_UNDO_COMMAND, CLEAR_HISTORY_COMMAND, COMMAND_PRIORITY_HIGH, configExtension, defineExtension, FORMAT_TEXT_COMMAND, HISTORY_PUSH_TAG, KEY_DOWN_COMMAND, mergeRegister, PASTE_COMMAND, REDO_COMMAND, SELECTION_CHANGE_COMMAND, UNDO_COMMAND} from 'lexical';
import {useEffect, useMemo, useRef, useState} from 'react';

import {applyMarkdownSourceEdit, planMarkdownSourceIndent} from '../../../sourceEditing';
import CodeActionMenuPlugin from '../playground/plugins/CodeActionMenuPlugin';
import {CodeHighlightExtension} from '../playground/plugins/CodeHighlightExtension';
import FloatingLinkEditorPlugin from '../playground/plugins/FloatingLinkEditorPlugin';
import MermaidPreviewPlugin from '../playground/plugins/MermaidPreviewPlugin';
import TableCellResizerPlugin from '../playground/plugins/TableCellResizer';
import TableClipboardPlugin from '../playground/plugins/TableClipboardPlugin';
import TableControlsPlugin from '../playground/plugins/TableControlsPlugin';
import TableScrollShadowPlugin from '../playground/plugins/TableScrollShadowPlugin';
import ContentEditable from '../playground/ui/ContentEditable';
import PlaygroundEditorTheme from '../playground/themes/PlaygroundEditorTheme';
import {validateUrl} from '../playground/utils/url';
import {MARKDOWN_NODES, MARKDOWN_TRANSFORMERS} from './transformers';
import {$exportMarkdown, $importMarkdown} from './markdownDocument';
import {markdownEditableReason} from './markdownPolicy';
import {useMarkdownSession} from './MarkdownBridge';
import MarkdownTableLayoutPlugin, {MARKDOWN_TABLE_MIN_COLUMN_WIDTH, MARKDOWN_TABLE_MIN_ROW_HEIGHT} from './markdownTableLayout';
import {$insertMarkdownCodeBlock} from './markdownCommands';

function MarkdownCanvas() {
  const [editor] = useLexicalComposerContext();
  const session = useMarkdownSession();
  const initialReason = useMemo(() => markdownEditableReason(session.initialValue), [session]);
  const [sourceMode, setSourceMode] = useState(!!initialReason);
  const sourceModeRef = useRef(sourceMode);
  const [source, setSource] = useState(session.initialValue);
  const sourceRef = useRef(source);
  const [reason, setReason] = useState(initialReason);
  const [readOnly, setReadOnly] = useState(session.readOnly);
  const [anchor, setAnchor] = useState<HTMLDivElement | null>(null);
  const [linkEditing, setLinkEditing] = useState(false);
  const [canUndo, setCanUndo] = useState(false);
  const [canRedo, setCanRedo] = useState(false);
  const [characters, setCharacters] = useState(source.length);
  const [blockType, setBlockType] = useState('paragraph');
  const [textFormats, setTextFormats] = useState({bold: false, italic: false});
  const sourceElement = useRef<HTMLTextAreaElement>(null);
  const sourceScrollTop = useRef(0);
  const visualSource = useRef(session.initialValue);
  const baseline = useRef('');
  const hydrating = useRef(false);
  // 文件原本是否以换行结尾：导入导出都沿用，避免第一次编辑就把收尾换行改掉。
  const trailingNewline = useRef(session.initialValue.endsWith('\n'));

  const readCurrent = () => {
    if (sourceModeRef.current) return sourceElement.current?.value ?? sourceRef.current;
    if (session.readOnly) return sourceRef.current;
    const markdown = editor.getEditorState().read(() => $exportMarkdown(trailingNewline.current));
    if (markdown !== baseline.current) {
      baseline.current = markdown;
      sourceRef.current = markdown;
    }
    return sourceRef.current;
  };

  useEffect(() => {
    const updateToolbar = () => {
      const selection = $getSelection();
      if (!$isRangeSelection(selection)) return;
      const node = selection.anchor.getNode();
      const block = [node, ...node.getParents()].find(parent => $isElementNode(parent) && !parent.isInline());
      setBlockType($isHeadingNode(block) ? block.getTag() : block?.getType() || 'paragraph');
      setTextFormats(previous => {
        const bold = selection.hasFormat('bold'), italic = selection.hasFormat('italic');
        return previous.bold === bold && previous.italic === italic ? previous : {bold, italic};
      });
    };
    baseline.current = editor.getEditorState().read(() => $exportMarkdown(trailingNewline.current));
    session.reader = () => {
      editor.update(() => {}, {discrete: true});
      return readCurrent();
    };
    session.setReadOnly = value => {setReadOnly(value); editor.setEditable(!value && !sourceModeRef.current);};
    editor.setEditable(!session.readOnly && !sourceModeRef.current);
    const cleanup = mergeRegister(
      registerMarkdownShortcuts(editor, MARKDOWN_TRANSFORMERS),
      editor.registerUpdateListener(({editorState, dirtyElements, dirtyLeaves}) => {
        editorState.read(updateToolbar);
        if (hydrating.current || sourceModeRef.current || (!dirtyElements.size && !dirtyLeaves.size)) return;
        const value = readCurrent();
        setCharacters(value.length);
        session.change(value);
      }),
      editor.registerCommand(SELECTION_CHANGE_COMMAND, () => {updateToolbar(); return false;}, COMMAND_PRIORITY_HIGH),
      editor.registerCommand(FORMAT_TEXT_COMMAND, format => !['bold', 'italic', 'strikethrough', 'code'].includes(format), COMMAND_PRIORITY_HIGH),
      editor.registerCommand(KEY_DOWN_COMMAND, event => {
        if ((event.metaKey || event.ctrlKey) && !event.shiftKey && !event.altKey && event.key.toLowerCase() === 'k' && editor.isEditable()) {
          event.preventDefault();
          setLinkEditing(true);
          editor.dispatchCommand(TOGGLE_LINK_COMMAND, 'https://');
          return true;
        }
        return false;
      }, COMMAND_PRIORITY_HIGH),
      editor.registerCommand(PASTE_COMMAND, event => {
        if (!editor.isEditable() || !event || !('clipboardData' in event) || !event.clipboardData) return false;
        const selection = $getSelection();
        const data = event.clipboardData;
        const text = data.getData('text/markdown') || data.getData('text/plain');
        if (!text || !$isRangeSelection(selection)) return false;
        const node = selection.anchor.getNode();
        if (node.getParents().some($isCodeNode) || $isCodeNode(node)) return false;
        if ($getTableCellNodeFromLexicalNode(node) || $isTableSelection(selection)) return false;
        event.preventDefault();
        $addUpdateTag(HISTORY_PUSH_TAG);
        // Unsupported syntax stays source, not a lossy set of rich nodes.
        if (markdownEditableReason(text)) {
          selection.insertRawText(text);
        } else {
          // 粘贴同样不吃 Markdown 的空行，否则粘进来的段落会被撑成双倍行距。
          const nodes = $generateNodesFromMarkdownString(text, MARKDOWN_TRANSFORMERS, false);
          if (nodes.length) selection.insertNodes(nodes);
        }
        return true;
      }, COMMAND_PRIORITY_HIGH),
      editor.registerCommand(CAN_UNDO_COMMAND, value => {setCanUndo(value); return false;}, COMMAND_PRIORITY_HIGH),
      editor.registerCommand(CAN_REDO_COMMAND, value => {setCanRedo(value); return false;}, COMMAND_PRIORITY_HIGH),
    );
    session.ready();
    return () => {session.reader = null; session.setReadOnly = null; cleanup();};
  }, [editor, session]);

  const switchView = (view: 'source' | 'visual') => {
    if ((view === 'source') === sourceModeRef.current) return;
    if (view === 'source') {
      editor.update(() => {}, {discrete: true});
      const value = readCurrent();
      sourceRef.current = value;
      visualSource.current = value;
      trailingNewline.current = value.endsWith('\n');
      setSource(value);
      sourceModeRef.current = true;
      setSourceMode(true);
      editor.setEditable(false);
      setLinkEditing(false);
    } else {
      const warning = markdownEditableReason(sourceRef.current);
      setReason(warning);
      if (warning) return;
      // Looking at source must not discard undo history, selections or the
      // session's table widths. Re-import only after actual source edits.
      if (sourceRef.current !== visualSource.current) {
        hydrating.current = true;
        trailingNewline.current = sourceRef.current.endsWith('\n');
        editor.update(() => {
          $importMarkdown(sourceRef.current);
          if (!$getRoot().getChildrenSize()) $getRoot().append($createParagraphNode());
        }, {discrete: true});
        baseline.current = editor.getEditorState().read(() => $exportMarkdown(trailingNewline.current));
        editor.dispatchCommand(CLEAR_HISTORY_COMMAND, undefined);
      }
      sourceModeRef.current = false;
      hydrating.current = false;
      setSourceMode(false);
      editor.setEditable(!session.readOnly);
    }
  };

  useEffect(() => {
    if (sourceMode && sourceElement.current) sourceElement.current.scrollTop = sourceScrollTop.current;
  }, [sourceMode]);

  const changeBlock = (type: string) => editor.update(() => {
    const selection = $getSelection();
    if (!$isRangeSelection(selection)) return;
    $setBlocksType(selection, () => type === 'code' ? $createCodeNode() : type === 'quote' ? $createQuoteNode() : type.startsWith('h') ? $createHeadingNode(type as 'h1') : $createParagraphNode());
  });
  const changeSource = (value: string) => {
    sourceRef.current = value;
    setSource(value);
    setReason(markdownEditableReason(value));
    setCharacters(value.length);
    session.change(value);
  };
  return <div className="workspace notebook-editor markdown-editor">
    <section className="editor-canvas">
      <div className="markdown-toolbar">
        <Radio.Group type="button" size="mini" aria-label="Markdown 视图" value={sourceMode ? 'source' : 'visual'} onChange={switchView} options={[{value: 'visual', label: readOnly ? '阅读' : '编辑', disabled: !!reason}, {value: 'source', label: '源码'}]} />
        {!sourceMode && !readOnly && <div className="markdown-tools" role="group" aria-label="Markdown 常用操作">
          <Button type="text" size="mini" aria-label="撤销" disabled={!canUndo} icon={<IconUndo />} onClick={() => editor.dispatchCommand(UNDO_COMMAND, undefined)} />
          <Button type="text" size="mini" aria-label="重做" disabled={!canRedo} icon={<IconRedo />} onClick={() => editor.dispatchCommand(REDO_COMMAND, undefined)} />
          <Select size="mini" aria-label="Markdown 段落格式" placeholder="段落" value={['paragraph', 'h1', 'h2', 'h3', 'quote', 'code'].includes(blockType) ? blockType : undefined} style={{width: 92}} onChange={changeBlock} options={[
            {label: '正文', value: 'paragraph'}, {label: '标题 1', value: 'h1'}, {label: '标题 2', value: 'h2'}, {label: '标题 3', value: 'h3'}, {label: '引用', value: 'quote'}, {label: '代码块', value: 'code'},
          ]} />
          <span className="markdown-tool-divider" aria-hidden="true" />
          <Button type="text" size="mini" aria-label="加粗" aria-pressed={textFormats.bold} disabled={blockType === 'code'} icon={<IconBold />} onMouseDown={e => e.preventDefault()} onClick={() => editor.dispatchCommand(FORMAT_TEXT_COMMAND, 'bold')} />
          <Button type="text" size="mini" aria-label="斜体" aria-pressed={textFormats.italic} disabled={blockType === 'code'} icon={<IconItalic />} onMouseDown={e => e.preventDefault()} onClick={() => editor.dispatchCommand(FORMAT_TEXT_COMMAND, 'italic')} />
          <Button type="text" size="mini" aria-label="插入或编辑链接" disabled={blockType === 'code'} icon={<IconLink />} onMouseDown={e => e.preventDefault()} onClick={() => {setLinkEditing(true); editor.dispatchCommand(TOGGLE_LINK_COMMAND, 'https://');}} />
          <span className="markdown-tool-divider" aria-hidden="true" />
          <Select size="mini" aria-label="Markdown 插入" placeholder="插入" value={undefined} disabled={blockType === 'code'} style={{width: 76}} onChange={(value: string) => {
            if (value === 'bullet') editor.dispatchCommand(INSERT_UNORDERED_LIST_COMMAND, undefined);
            else if (value === 'number') editor.dispatchCommand(INSERT_ORDERED_LIST_COMMAND, undefined);
            else if (value === 'check') editor.dispatchCommand(INSERT_CHECK_LIST_COMMAND, undefined);
            else if (value === 'mermaid') editor.update(() => $insertMarkdownCodeBlock('mermaid', 'flowchart LR\n  A[开始] --> B[完成]'));
            else editor.dispatchCommand(INSERT_TABLE_COMMAND, {rows: '3', columns: '3', includeHeaders: {rows: true, columns: false}});
          }} options={[{value: 'table', label: '表格'}, {value: 'bullet', label: '无序列表'}, {value: 'number', label: '有序列表'}, {value: 'check', label: '任务列表'}, {value: 'mermaid', label: '流程图（Mermaid）'}]} />
        </div>}
        <span className="markdown-kind">Markdown</span>
      </div>
      {sourceMode && reason && <div className="markdown-source-note" role="note">{reason}</div>}
      {sourceMode && <textarea ref={sourceElement} className="markdown-source" aria-label="Markdown 源码" spellCheck={false} autoCapitalize="off" autoCorrect="off" readOnly={readOnly} value={source} onScroll={event => {sourceScrollTop.current = event.currentTarget.scrollTop;}} onChange={event => changeSource(event.currentTarget.value)} onKeyDown={event => {
        if (readOnly || event.nativeEvent.isComposing || event.key !== 'Tab' || event.altKey || event.ctrlKey || event.metaKey) return;
        event.preventDefault();
        const element = event.currentTarget;
        const edit = planMarkdownSourceIndent(element.value, element.selectionStart, element.selectionEnd, event.shiftKey);
        if (edit) applyMarkdownSourceEdit(element, edit, changeSource);
      }} />}
      <div className="editor-shell markdown-visual" hidden={sourceMode}>
        <div className="editor-container"><div className="editor-scroller"><div className="editor" ref={setAnchor}><ContentEditable placeholder="输入 Markdown，或直接开始写作…" /></div></div></div>
        <TableClipboardPlugin />
        <MarkdownTableLayoutPlugin />
        <TableCellResizerPlugin initializeColumnWidths={false} minColumnWidth={MARKDOWN_TABLE_MIN_COLUMN_WIDTH} minRowHeight={MARKDOWN_TABLE_MIN_ROW_HEIGHT} />
        <TableControlsPlugin markdownOnly />
        <TableScrollShadowPlugin />
        {anchor && <MermaidPreviewPlugin anchorElem={anchor} />}
        {anchor && !sourceMode && <><CodeActionMenuPlugin anchorElem={anchor} /><FloatingLinkEditorPlugin anchorElem={anchor} markdownOnly isLinkEditMode={linkEditing} setIsLinkEditMode={setLinkEditing} /></>}
      </div>
      <footer className="document-statusbar"><span>{characters.toLocaleString()} 字符{readOnly ? ' · 只读' : ''}</span></footer>
    </section>
  </div>;
}

export default function MarkdownApp() {
  const session = useMarkdownSession();
  const extension = useMemo(() => defineExtension({
    name: 'Mica/Markdown',
    namespace: 'MicaMarkdown',
    nodes: MARKDOWN_NODES,
    theme: PlaygroundEditorTheme,
    dependencies: [RichTextExtension, HistoryExtension, LinkExtension, ListExtension, CheckListExtension, HorizontalRuleExtension,
      configExtension(CodeHighlightExtension, {mode: 'prism'}),
      configExtension(TableExtension, {hasCellMerge: false, hasCellBackgroundColor: false, hasHorizontalScroll: true}),
      configExtension(TabIndentationExtension, {maxIndent: 7}),
      configExtension(LinkExtension, {validateUrl}),
    ],
    $initialEditorState: () => {
      if (!markdownEditableReason(session.initialValue)) $importMarkdown(session.initialValue);
      if (!$getRoot().getChildrenSize()) $getRoot().append($createParagraphNode());
    },
  }), [session]);
  return <LexicalExtensionComposer extension={extension} contentEditable={null}><MarkdownCanvas /></LexicalExtensionComposer>;
}
