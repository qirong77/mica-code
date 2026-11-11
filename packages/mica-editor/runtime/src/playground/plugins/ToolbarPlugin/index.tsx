/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {useMergeRefs} from '@floating-ui/react';
import {$isCodeNode} from '@lexical/code';
import {
  getCodeLanguageOptions as getCodeLanguageOptionsPrism,
  normalizeCodeLanguage as normalizeCodeLanguagePrism,
} from '@lexical/code-prism';
import {
  getCodeLanguageOptions as getCodeLanguageOptionsShiki,
  getCodeThemeOptions as getCodeThemeOptionsShiki,
  normalizeCodeLanguage as normalizeCodeLanguageShiki,
} from '@lexical/code-shiki';
import {INSERT_HORIZONTAL_RULE_COMMAND} from '@lexical/extension';
import {$isLinkNode, TOGGLE_LINK_COMMAND} from '@lexical/link';
import {$isListNode, ListNode} from '@lexical/list';
import {useLexicalFocusManagerRef} from '@lexical/react/useLexicalFocusManagerRef';
import {useLexicalRovingTabIndexRef} from '@lexical/react/useLexicalRovingTabIndexRef';
import {$isHeadingNode} from '@lexical/rich-text';
import {
  $getSelectionStyleValueForProperty,
  $isParentElementRTL,
  $patchStyleText,
} from '@lexical/selection';
import {$isTableNode, $isTableSelection} from '@lexical/table';
import {$getNearestNodeOfType, $isEditorIsNestedEditor} from '@lexical/utils';
import {
  $addUpdateTag,
  $findMatchingParent,
  $getNodeByKey,
  $getSelection,
  $isElementNode,
  $isNodeSelection,
  $isRangeSelection,
  $isRootOrShadowRoot,
  $onUpdate,
  type AnyLexicalCommand,
  CAN_REDO_COMMAND,
  CAN_UNDO_COMMAND,
  COMMAND_PRIORITY_CRITICAL,
  type CommandPayloadType,
  type ElementFormatType,
  FORMAT_ELEMENT_COMMAND,
  FORMAT_TEXT_COMMAND,
  HISTORIC_TAG,
  INDENT_CONTENT_COMMAND,
  IS_APPLE,
  type LexicalEditor,
  type LexicalNode,
  mergeRegister,
  type NodeKey,
  OUTDENT_CONTENT_COMMAND,
  REDO_COMMAND,
  SELECTION_CHANGE_COMMAND,
  SKIP_DOM_SELECTION_TAG,
  SKIP_SELECTION_FOCUS_TAG,
  type TextFormatType,
  UNDO_COMMAND,
} from 'lexical';
import {type Dispatch, type JSX, useCallback, useEffect, useState} from 'react';

import {useSettings} from '../../context/SettingsContext';
import {
  blockTypeToBlockName,
  DEFAULT_FONT_SIZE,
  useToolbarState,
} from '../../context/ToolbarContext';
import useModal from '../../hooks/useModal';
import DropDown, {DropDownItem} from '../../ui/DropDown';
import DropdownColorPicker from '../../ui/DropdownColorPicker';
import {isKeyboardInput} from '../../utils/focusUtils';
import {getSelectedNode} from '../../utils/getSelectedNode';
import {INSERT_COLLAPSIBLE_COMMAND} from '../CollapsibleExtension';
import {TOGGLE_COMMENTS_COMMAND} from '../CommentPlugin';
import {INSERT_DATETIME_COMMAND} from '../DateTimeExtension';
import {InsertEquationDialog} from '../EquationsExtension';
import {INSERT_EXCALIDRAW_COMMAND} from '../ExcalidrawExtension';
import {InsertImageDialog} from '../ImagesExtension';
import InsertLayoutDialog from '../LayoutExtension/InsertLayoutDialog';
import {$isRubyNode, $toggleRuby} from '../RubyExtension/RubyNode';
import {shortcut} from '../ShortcutsExtension/shortcuts';
import {InsertTableDialog} from '../TablePlugin';
import FontSize, {parseFontSizeForToolbar} from './fontSize';
import {
  clearFormatting,
  formatBulletList,
  formatCheckList,
  formatCode,
  formatHeading,
  formatNumberedList,
  formatParagraph,
  formatQuote,
} from './utils';

// eslint-disable-next-line @typescript-eslint/no-unused-vars
const rootTypeToRootName = {
  root: '正文',
  table: '表格',
};

// Keep the shared block keys unchanged; only localize their toolbar labels.
const BLOCK_TYPE_LABELS: Record<keyof typeof blockTypeToBlockName, string> = {
  bullet: '无序列表',
  check: '任务列表',
  code: '代码块',
  h1: '标题 1',
  h2: '标题 2',
  h3: '标题 3',
  h4: '标题 4',
  h5: '标题 5',
  h6: '标题 6',
  number: '有序列表',
  paragraph: '正文',
  quote: '引用',
};

const CODE_LANGUAGE_OPTIONS_PRISM: [string, string][] =
  getCodeLanguageOptionsPrism().filter(option =>
    [
      'c',
      'clike',
      'cpp',
      'css',
      'go',
      'html',
      'java',
      'js',
      'javascript',
      'markdown',
      'objc',
      'objective-c',
      'plain',
      'powershell',
      'py',
      'python',
      'rust',
      'sql',
      'swift',
      'typescript',
      'xml',
    ].includes(option[0]),
  );

const CODE_LANGUAGE_OPTIONS_SHIKI: [string, string][] =
  getCodeLanguageOptionsShiki().filter(option =>
    [
      'c',
      'clike',
      'cpp',
      'css',
      'go',
      'html',
      'java',
      'js',
      'javascript',
      'markdown',
      'objc',
      'objective-c',
      'plain',
      'powershell',
      'py',
      'python',
      'rust',
      'sql',
      'typescript',
      'xml',
    ].includes(option[0]),
  );

const CODE_THEME_OPTIONS_SHIKI: [string, string][] =
  getCodeThemeOptionsShiki().filter(option =>
    [
      'catppuccin-latte',
      'everforest-light',
      'github-light',
      'gruvbox-light-medium',
      'kanagawa-lotus',
      'dark-plus',
      'light-plus',
      'material-theme-lighter',
      'min-light',
      'one-light',
      'rose-pine-dawn',
      'slack-ochin',
      'snazzy-light',
      'solarized-light',
      'vitesse-light',
    ].includes(option[0]),
  );

const FONT_FAMILY_OPTIONS: [string, string][] = [
  ['Arial', 'Arial'],
  ['Courier New', 'Courier New'],
  ['Georgia', 'Georgia'],
  ['Times New Roman', 'Times New Roman'],
  ['Trebuchet MS', 'Trebuchet MS'],
  ['Verdana', 'Verdana'],
];

const FONT_SIZE_OPTIONS: [string, string][] = [
  ['10px', '10px'],
  ['11px', '11px'],
  ['12px', '12px'],
  ['13px', '13px'],
  ['14px', '14px'],
  ['15px', '15px'],
  ['16px', '16px'],
  ['17px', '17px'],
  ['18px', '18px'],
  ['19px', '19px'],
  ['20px', '20px'],
];

const ELEMENT_FORMAT_OPTIONS: {
  [key in Exclude<ElementFormatType, ''>]: {
    icon: string;
    iconRTL: string;
    name: string;
  };
} = {
  center: {
    icon: 'center-align',
    iconRTL: 'center-align',
    name: '居中对齐',
  },
  end: {
    icon: 'right-align',
    iconRTL: 'left-align',
    name: '末端对齐',
  },
  justify: {
    icon: 'justify-align',
    iconRTL: 'justify-align',
    name: '两端对齐',
  },
  left: {
    icon: 'left-align',
    iconRTL: 'left-align',
    name: '左对齐',
  },
  right: {
    icon: 'right-align',
    iconRTL: 'right-align',
    name: '右对齐',
  },
  start: {
    icon: 'left-align',
    iconRTL: 'right-align',
    name: '起始对齐',
  },
};

function dropDownActiveClass(active: boolean) {
  if (active) {
    return 'active dropdown-item-active';
  } else {
    return '';
  }
}

function BlockFormatDropDown({
  editor,
  blockType,
  rootType,
  disabled = false,
}: {
  blockType: keyof typeof blockTypeToBlockName;
  rootType: keyof typeof rootTypeToRootName;
  editor: LexicalEditor;
  disabled?: boolean;
}): JSX.Element {
  return (
    <DropDown
      disabled={disabled}
      buttonClassName="toolbar-item block-controls"
      buttonIconClassName={'icon block-type ' + blockType}
      buttonLabel={BLOCK_TYPE_LABELS[blockType]}
      buttonAriaLabel="段落样式">
      <DropDownItem
        className={
          'item wide ' + dropDownActiveClass(blockType === 'paragraph')
        }
        onClick={() => formatParagraph(editor)}>
        <div className="icon-text-container">
          <i className="icon paragraph" />
          <span className="text">正文</span>
        </div>
        <span className="shortcut">{shortcut('NORMAL')}</span>
      </DropDownItem>
      <DropDownItem
        className={'item wide ' + dropDownActiveClass(blockType === 'h1')}
        onClick={() => formatHeading(editor, blockType, 'h1')}>
        <div className="icon-text-container">
          <i className="icon h1" />
          <span className="text">标题 1</span>
        </div>
        <span className="shortcut">{shortcut('HEADING1')}</span>
      </DropDownItem>
      <DropDownItem
        className={'item wide ' + dropDownActiveClass(blockType === 'h2')}
        onClick={() => formatHeading(editor, blockType, 'h2')}>
        <div className="icon-text-container">
          <i className="icon h2" />
          <span className="text">标题 2</span>
        </div>
        <span className="shortcut">{shortcut('HEADING2')}</span>
      </DropDownItem>
      <DropDownItem
        className={'item wide ' + dropDownActiveClass(blockType === 'h3')}
        onClick={() => formatHeading(editor, blockType, 'h3')}>
        <div className="icon-text-container">
          <i className="icon h3" />
          <span className="text">标题 3</span>
        </div>
        <span className="shortcut">{shortcut('HEADING3')}</span>
      </DropDownItem>
      <DropDownItem
        className={'item wide ' + dropDownActiveClass(blockType === 'number')}
        onClick={() => formatNumberedList(editor, blockType)}>
        <div className="icon-text-container">
          <i className="icon numbered-list" />
          <span className="text">有序列表</span>
        </div>
        <span className="shortcut">{shortcut('NUMBERED_LIST')}</span>
      </DropDownItem>
      <DropDownItem
        className={'item wide ' + dropDownActiveClass(blockType === 'bullet')}
        onClick={() => formatBulletList(editor, blockType)}>
        <div className="icon-text-container">
          <i className="icon bullet-list" />
          <span className="text">无序列表</span>
        </div>
        <span className="shortcut">{shortcut('BULLET_LIST')}</span>
      </DropDownItem>
      <DropDownItem
        className={'item wide ' + dropDownActiveClass(blockType === 'check')}
        onClick={() => formatCheckList(editor, blockType)}>
        <div className="icon-text-container">
          <i className="icon check-list" />
          <span className="text">任务列表</span>
        </div>
        <span className="shortcut">{shortcut('CHECK_LIST')}</span>
      </DropDownItem>
      <DropDownItem
        className={'item wide ' + dropDownActiveClass(blockType === 'quote')}
        onClick={() => formatQuote(editor, blockType)}>
        <div className="icon-text-container">
          <i className="icon quote" />
          <span className="text">引用</span>
        </div>
        <span className="shortcut">{shortcut('QUOTE')}</span>
      </DropDownItem>
      <DropDownItem
        className={'item wide ' + dropDownActiveClass(blockType === 'code')}
        onClick={() => formatCode(editor, blockType)}>
        <div className="icon-text-container">
          <i className="icon code" />
          <span className="text">代码块</span>
        </div>
        <span className="shortcut">{shortcut('CODE_BLOCK')}</span>
      </DropDownItem>
    </DropDown>
  );
}

function Divider(): JSX.Element {
  return <div className="divider" />;
}

function FontDropDown({
  editor,
  value,
  style,
  disabled = false,
}: {
  editor: LexicalEditor;
  value: string;
  style: string;
  disabled?: boolean;
}): JSX.Element {
  const handleClick = useCallback(
    (option: string) => {
      editor.update(() => {
        $addUpdateTag(SKIP_SELECTION_FOCUS_TAG);
        const selection = $getSelection();
        if (selection !== null) {
          $patchStyleText(selection, {
            [style]: option,
          });
        }
      });
    },
    [editor, style],
  );

  const buttonAriaLabel = style === 'font-family' ? '字体' : '字号';

  return (
    <DropDown
      disabled={disabled}
      buttonClassName={'toolbar-item ' + style}
      buttonLabel={value}
      buttonIconClassName={
        style === 'font-family' ? 'icon block-type font-family' : ''
      }
      buttonAriaLabel={buttonAriaLabel}>
      {(style === 'font-family' ? FONT_FAMILY_OPTIONS : FONT_SIZE_OPTIONS).map(
        ([option, text]) => (
          <DropDownItem
            className={`item ${dropDownActiveClass(value === option)} ${style === 'font-size' ? 'fontsize-item' : ''}`}
            onClick={() => handleClick(option)}
            key={option}>
            <span className="text">{text}</span>
          </DropDownItem>
        ),
      )}
    </DropDown>
  );
}

function ElementFormatDropdown({
  editor,
  value,
  isRTL,
  disabled = false,
}: {
  editor: LexicalEditor;
  value: ElementFormatType;
  isRTL: boolean;
  disabled: boolean;
}) {
  const formatOption = ELEMENT_FORMAT_OPTIONS[value || 'left'];

  return (
    <DropDown
      disabled={disabled}
      buttonLabel={formatOption.name}
      buttonIconClassName={`icon ${isRTL ? formatOption.iconRTL : formatOption.icon}`}
      buttonClassName="toolbar-item spaced alignment"
      buttonAriaLabel="对齐与缩进">
      <DropDownItem
        onClick={() => {
          editor.dispatchCommand(FORMAT_ELEMENT_COMMAND, 'left');
        }}
        className="item wide">
        <div className="icon-text-container">
          <i className="icon left-align" />
          <span className="text">左对齐</span>
        </div>
        <span className="shortcut">{shortcut('LEFT_ALIGN')}</span>
      </DropDownItem>
      <DropDownItem
        onClick={() => {
          editor.dispatchCommand(FORMAT_ELEMENT_COMMAND, 'center');
        }}
        className="item wide">
        <div className="icon-text-container">
          <i className="icon center-align" />
          <span className="text">居中对齐</span>
        </div>
        <span className="shortcut">{shortcut('CENTER_ALIGN')}</span>
      </DropDownItem>
      <DropDownItem
        onClick={() => {
          editor.dispatchCommand(FORMAT_ELEMENT_COMMAND, 'right');
        }}
        className="item wide">
        <div className="icon-text-container">
          <i className="icon right-align" />
          <span className="text">右对齐</span>
        </div>
        <span className="shortcut">{shortcut('RIGHT_ALIGN')}</span>
      </DropDownItem>
      <DropDownItem
        onClick={() => {
          editor.dispatchCommand(FORMAT_ELEMENT_COMMAND, 'justify');
        }}
        className="item wide">
        <div className="icon-text-container">
          <i className="icon justify-align" />
          <span className="text">两端对齐</span>
        </div>
        <span className="shortcut">{shortcut('JUSTIFY_ALIGN')}</span>
      </DropDownItem>
      <DropDownItem
        onClick={() => {
          editor.dispatchCommand(FORMAT_ELEMENT_COMMAND, 'start');
        }}
        className="item wide">
        <i
          className={`icon ${isRTL ? ELEMENT_FORMAT_OPTIONS.start.iconRTL : ELEMENT_FORMAT_OPTIONS.start.icon}`}
        />
        <span className="text">起始对齐</span>
      </DropDownItem>
      <DropDownItem
        onClick={() => {
          editor.dispatchCommand(FORMAT_ELEMENT_COMMAND, 'end');
        }}
        className="item wide">
        <i
          className={`icon ${isRTL ? ELEMENT_FORMAT_OPTIONS.end.iconRTL : ELEMENT_FORMAT_OPTIONS.end.icon}`}
        />
        <span className="text">末端对齐</span>
      </DropDownItem>
      <Divider />
      <DropDownItem
        onClick={() => {
          editor.dispatchCommand(OUTDENT_CONTENT_COMMAND);
        }}
        className="item wide">
        <div className="icon-text-container">
          <i className={'icon ' + (isRTL ? 'indent' : 'outdent')} />
          <span className="text">减少缩进</span>
        </div>
        <span className="shortcut">{shortcut('OUTDENT')}</span>
      </DropDownItem>
      <DropDownItem
        onClick={() => {
          editor.dispatchCommand(INDENT_CONTENT_COMMAND);
        }}
        className="item wide">
        <div className="icon-text-container">
          <i className={'icon ' + (isRTL ? 'outdent' : 'indent')} />
          <span className="text">增加缩进</span>
        </div>
        <span className="shortcut">{shortcut('INDENT')}</span>
      </DropDownItem>
    </DropDown>
  );
}

function $findTopLevelElement(node: LexicalNode) {
  let topLevelElement =
    node.getKey() === 'root'
      ? node
      : $findMatchingParent(node, e => {
          const parent = e.getParent();
          return parent !== null && $isRootOrShadowRoot(parent);
        });

  if (topLevelElement === null) {
    topLevelElement = node.getTopLevelElementOrThrow();
  }
  return topLevelElement;
}

export default function ToolbarPlugin({
  editor,
  activeEditor,
  setActiveEditor,
  setIsLinkEditMode,
  setIsRubyEditMode,
}: {
  editor: LexicalEditor;
  activeEditor: LexicalEditor;
  setActiveEditor: Dispatch<LexicalEditor>;
  setIsLinkEditMode: Dispatch<boolean>;
  setIsRubyEditMode: Dispatch<boolean>;
}): JSX.Element {
  const [selectedElementKey, setSelectedElementKey] = useState<NodeKey | null>(
    null,
  );
  const [modal, showModal] = useModal();
  const [isEditable, setIsEditable] = useState(() => editor.isEditable());
  const {toolbarState, updateToolbarState} = useToolbarState();
  const rovingRef = useLexicalRovingTabIndexRef();
  const focusManagerRef = useLexicalFocusManagerRef();
  const toolbarRef = useMergeRefs([rovingRef, focusManagerRef]);

  const dispatchToolbarCommand = <T extends AnyLexicalCommand>(
    command: T,
    payload: CommandPayloadType<T> | undefined = undefined,
    skipRefocus: boolean = false,
  ) => {
    activeEditor.update(() => {
      if (skipRefocus) {
        $addUpdateTag(SKIP_DOM_SELECTION_TAG);
      }

      // Re-assert on Type so that payload can have a default param
      activeEditor.dispatchCommand(command, payload as CommandPayloadType<T>);
    });
  };

  const dispatchFormatTextCommand = (
    payload: TextFormatType,
    skipRefocus: boolean = false,
  ) => dispatchToolbarCommand(FORMAT_TEXT_COMMAND, payload, skipRefocus);

  const $handleHeadingNode = useCallback(
    (selectedElement: LexicalNode) => {
      const type = $isHeadingNode(selectedElement)
        ? selectedElement.getTag()
        : selectedElement.getType();

      if (type in blockTypeToBlockName) {
        updateToolbarState(
          'blockType',
          type as keyof typeof blockTypeToBlockName,
        );
      }
    },
    [updateToolbarState],
  );

  const {
    settings: {isCodeHighlighted, isCodeShiki},
  } = useSettings();

  const $handleCodeNode = useCallback(
    (element: LexicalNode) => {
      if ($isCodeNode(element)) {
        const language = element.getLanguage();
        updateToolbarState(
          'codeLanguage',
          language
            ? (isCodeHighlighted &&
                (isCodeShiki
                  ? normalizeCodeLanguageShiki(language)
                  : normalizeCodeLanguagePrism(language))) ||
                language
            : '',
        );
        const theme = element.getTheme();
        updateToolbarState('codeTheme', theme || '');
        return;
      }
    },
    [updateToolbarState, isCodeHighlighted, isCodeShiki],
  );

  const $updateToolbar = useCallback(() => {
    const selection = $getSelection();
    if ($isRangeSelection(selection)) {
      if (activeEditor !== editor && $isEditorIsNestedEditor(activeEditor)) {
        const rootElement = activeEditor.getRootElement();
        updateToolbarState(
          'isImageCaption',
          !!rootElement?.parentElement?.classList.contains(
            'image-caption-container',
          ),
        );
      } else {
        updateToolbarState('isImageCaption', false);
      }

      const anchorNode = selection.anchor.getNode();
      const element = $findTopLevelElement(anchorNode);
      const elementKey = element.getKey();
      const elementDOM = activeEditor.getElementByKey(elementKey);

      updateToolbarState('isRTL', $isParentElementRTL(selection));

      // Update links
      const node = getSelectedNode(selection);
      const parent = node.getParent();
      const isLink = $isLinkNode(parent) || $isLinkNode(node);
      updateToolbarState('isLink', isLink);

      const tableNode = $findMatchingParent(node, $isTableNode);
      if ($isTableNode(tableNode)) {
        updateToolbarState('rootType', 'table');
      } else {
        updateToolbarState('rootType', 'root');
      }

      if (elementDOM !== null) {
        setSelectedElementKey(elementKey);
        if ($isListNode(element)) {
          const parentList = $getNearestNodeOfType(anchorNode, ListNode);
          const type = parentList
            ? parentList.getListType()
            : element.getListType();

          updateToolbarState('blockType', type);
        } else {
          $handleHeadingNode(element);
          $handleCodeNode(element);
        }
      }

      // Handle buttons
      updateToolbarState(
        'fontColor',
        $getSelectionStyleValueForProperty(selection, 'color', '#000'),
      );
      updateToolbarState(
        'bgColor',
        $getSelectionStyleValueForProperty(
          selection,
          'background-color',
          '#fff',
        ),
      );
      updateToolbarState(
        'fontFamily',
        $getSelectionStyleValueForProperty(selection, 'font-family', 'Arial'),
      );
      let matchingParent;
      if ($isLinkNode(parent)) {
        // If node is a link, we need to fetch the parent paragraph node to set format
        matchingParent = $findMatchingParent(
          node,
          parentNode => $isElementNode(parentNode) && !parentNode.isInline(),
        );
      }

      // If matchingParent is a valid node, pass it's format type
      updateToolbarState(
        'elementFormat',
        $isElementNode(matchingParent)
          ? matchingParent.getFormatType()
          : $isElementNode(node)
            ? node.getFormatType()
            : parent?.getFormatType() || 'left',
      );
    }
    if ($isRangeSelection(selection) || $isTableSelection(selection)) {
      // Update text format
      updateToolbarState('isBold', selection.hasFormat('bold'));
      updateToolbarState('isItalic', selection.hasFormat('italic'));
      updateToolbarState('isUnderline', selection.hasFormat('underline'));
      updateToolbarState(
        'isStrikethrough',
        selection.hasFormat('strikethrough'),
      );
      updateToolbarState('isSubscript', selection.hasFormat('subscript'));
      updateToolbarState('isSuperscript', selection.hasFormat('superscript'));
      updateToolbarState('isHighlight', selection.hasFormat('highlight'));
      updateToolbarState('isCode', selection.hasFormat('code'));
      updateToolbarState(
        'fontSize',
        $getSelectionStyleValueForProperty(
          selection,
          'font-size',
          `${DEFAULT_FONT_SIZE}px`,
        ),
      );
      updateToolbarState('isLowercase', selection.hasFormat('lowercase'));
      updateToolbarState('isUppercase', selection.hasFormat('uppercase'));
      updateToolbarState('isCapitalize', selection.hasFormat('capitalize'));
    }
    if ($isNodeSelection(selection)) {
      const nodes = selection.getNodes();
      for (const selectedNode of nodes) {
        const parentList = $getNearestNodeOfType(selectedNode, ListNode);
        if (parentList) {
          const type = parentList.getListType();
          updateToolbarState('blockType', type);
        } else {
          const selectedElement = $findTopLevelElement(selectedNode);
          $handleHeadingNode(selectedElement);
          $handleCodeNode(selectedElement);
          // Update elementFormat for node selection (e.g., images)
          if ($isElementNode(selectedElement)) {
            updateToolbarState(
              'elementFormat',
              selectedElement.getFormatType(),
            );
          }
        }
      }
    }
  }, [
    activeEditor,
    editor,
    updateToolbarState,
    $handleHeadingNode,
    $handleCodeNode,
  ]);

  useEffect(() => {
    return editor.registerCommand(
      SELECTION_CHANGE_COMMAND,
      (_payload, newEditor) => {
        setActiveEditor(newEditor);
        $onUpdate(() => newEditor.read('latest', $updateToolbar));
        return false;
      },
      COMMAND_PRIORITY_CRITICAL,
    );
  }, [editor, $updateToolbar, setActiveEditor]);

  useEffect(() => {
    activeEditor.read('latest', () => {
      $updateToolbar();
    });
  }, [activeEditor, $updateToolbar]);

  useEffect(() => {
    return mergeRegister(
      editor.registerEditableListener(editable => {
        setIsEditable(editable);
      }),
      activeEditor.registerUpdateListener(({editorState}) => {
        editorState.read(
          () => {
            $updateToolbar();
          },
          {editor: activeEditor},
        );
      }),
      activeEditor.registerCommand(
        CAN_UNDO_COMMAND,
        payload => {
          updateToolbarState('canUndo', payload);
          return false;
        },
        COMMAND_PRIORITY_CRITICAL,
      ),
      activeEditor.registerCommand(
        CAN_REDO_COMMAND,
        payload => {
          updateToolbarState('canRedo', payload);
          return false;
        },
        COMMAND_PRIORITY_CRITICAL,
      ),
    );
  }, [$updateToolbar, activeEditor, editor, updateToolbarState]);

  const applyStyleText = useCallback(
    (
      styles: Record<string, string>,
      skipHistoryStack?: boolean,
      skipRefocus: boolean = false,
    ) => {
      activeEditor.update(
        () => {
          if (skipRefocus) {
            $addUpdateTag(SKIP_DOM_SELECTION_TAG);
          }
          const selection = $getSelection();
          if (selection !== null) {
            $patchStyleText(selection, styles);
          }
        },
        skipHistoryStack ? {tag: HISTORIC_TAG} : {},
      );
    },
    [activeEditor],
  );

  const onFontColorSelect = useCallback(
    (value: string, skipHistoryStack: boolean, skipRefocus: boolean) => {
      applyStyleText({color: value}, skipHistoryStack, skipRefocus);
    },
    [applyStyleText],
  );

  const onBgColorSelect = useCallback(
    (value: string, skipHistoryStack: boolean, skipRefocus: boolean) => {
      applyStyleText(
        {'background-color': value},
        skipHistoryStack,
        skipRefocus,
      );
    },
    [applyStyleText],
  );

  const insertLink = useCallback(() => {
    setIsLinkEditMode(true);
    activeEditor.dispatchCommand(TOGGLE_LINK_COMMAND, 'https://');
  }, [activeEditor, setIsLinkEditMode]);

  const insertRuby = useCallback(() => {
    const {hasRuby, hasSelection} = activeEditor.read(() => {
      const selection = $getSelection();
      if ($isRangeSelection(selection)) {
        return {
          hasRuby: selection.getNodes().some($isRubyNode),
          hasSelection: !selection.isCollapsed(),
        };
      }
      return {hasRuby: false, hasSelection: false};
    });
    if (hasRuby) {
      activeEditor.update(() => {
        $toggleRuby(null);
      });
    } else if (hasSelection) {
      setIsRubyEditMode(true);
    }
  }, [activeEditor, setIsRubyEditMode]);

  const onCodeLanguageSelect = useCallback(
    (value: string | null) => {
      activeEditor.update(() => {
        $addUpdateTag(SKIP_SELECTION_FOCUS_TAG);
        if (selectedElementKey !== null) {
          const node = $getNodeByKey(selectedElementKey);
          if ($isCodeNode(node)) {
            node.setLanguage(value);
          }
        }
      });
    },
    [activeEditor, selectedElementKey],
  );
  const onCodeThemeSelect = useCallback(
    (value: string) => {
      activeEditor.update(() => {
        if (selectedElementKey !== null) {
          const node = $getNodeByKey(selectedElementKey);
          if ($isCodeNode(node)) {
            node.setTheme(value);
          }
        }
      });
    },
    [activeEditor, selectedElementKey],
  );
  const canViewerSeeInsertDropdown = !toolbarState.isImageCaption;

  return (
    <div
      ref={toolbarRef}
      className="toolbar"
      role="toolbar"
      aria-label="编辑工具栏">
      <div className="toolbar-primary">
        <div className="toolbar-group" role="group" aria-label="编辑历史">
          <button
            disabled={!toolbarState.canUndo || !isEditable}
            onClick={e =>
              dispatchToolbarCommand(
                UNDO_COMMAND,
                undefined,
                isKeyboardInput(e),
              )
            }
            title={IS_APPLE ? '撤销 (⌘Z)' : '撤销 (Ctrl+Z)'}
            type="button"
            className="toolbar-item spaced"
            aria-label="撤销">
            <i className="format undo" />
          </button>
          <button
            disabled={!toolbarState.canRedo || !isEditable}
            onClick={e =>
              dispatchToolbarCommand(
                REDO_COMMAND,
                undefined,
                isKeyboardInput(e),
              )
            }
            title={IS_APPLE ? '重做 (⇧⌘Z)' : '重做 (Ctrl+Y)'}
            type="button"
            className="toolbar-item"
            aria-label="重做">
            <i className="format redo" />
          </button>
        </div>
        {toolbarState.blockType in blockTypeToBlockName &&
          activeEditor === editor && (
            <div className="toolbar-group" role="group" aria-label="段落格式">
              <BlockFormatDropDown
                disabled={!isEditable}
                blockType={toolbarState.blockType}
                rootType={toolbarState.rootType}
                editor={activeEditor}
              />
            </div>
          )}
        {toolbarState.blockType === 'code' && isCodeHighlighted ? (
          <div
            className="toolbar-group toolbar-code-options"
            role="group"
            aria-label="代码选项">
            {!isCodeShiki && (
              <DropDown
                disabled={!isEditable}
                buttonClassName="toolbar-item code-language"
                buttonLabel={
                  toolbarState.codeLanguage
                    ? (CODE_LANGUAGE_OPTIONS_PRISM.find(
                        opt =>
                          opt[0] ===
                          normalizeCodeLanguagePrism(toolbarState.codeLanguage),
                      ) || ['', ''])[1]
                    : '无语言'
                }
                buttonAriaLabel="代码语言">
                <DropDownItem
                  className={`item ${dropDownActiveClass(!toolbarState.codeLanguage)}`}
                  onClick={() => onCodeLanguageSelect(null)}
                  key="__no_language__">
                  <span className="text">无语言</span>
                </DropDownItem>
                {CODE_LANGUAGE_OPTIONS_PRISM.map(([value, name]) => {
                  return (
                    <DropDownItem
                      className={`item ${dropDownActiveClass(value === toolbarState.codeLanguage)}`}
                      onClick={() => onCodeLanguageSelect(value)}
                      key={value}>
                      <span className="text">{name}</span>
                    </DropDownItem>
                  );
                })}
              </DropDown>
            )}
            {isCodeShiki && (
              <>
                <DropDown
                  disabled={!isEditable}
                  buttonClassName="toolbar-item code-language"
                  buttonLabel={
                    toolbarState.codeLanguage
                      ? (CODE_LANGUAGE_OPTIONS_SHIKI.find(
                          opt =>
                            opt[0] ===
                            normalizeCodeLanguageShiki(
                              toolbarState.codeLanguage,
                            ),
                        ) || ['', ''])[1]
                      : '无语言'
                  }
                  buttonAriaLabel="代码语言">
                  <DropDownItem
                    className={`item ${dropDownActiveClass(!toolbarState.codeLanguage)}`}
                    onClick={() => onCodeLanguageSelect(null)}
                    key="__no_language__">
                    <span className="text">无语言</span>
                  </DropDownItem>
                  {CODE_LANGUAGE_OPTIONS_SHIKI.map(([value, name]) => {
                    return (
                      <DropDownItem
                        className={`item ${dropDownActiveClass(value === toolbarState.codeLanguage)}`}
                        onClick={() => onCodeLanguageSelect(value)}
                        key={value}>
                        <span className="text">{name}</span>
                      </DropDownItem>
                    );
                  })}
                </DropDown>
                <DropDown
                  disabled={!isEditable}
                  buttonClassName="toolbar-item code-language"
                  buttonLabel={
                    (CODE_THEME_OPTIONS_SHIKI.find(
                      opt => opt[0] === toolbarState.codeTheme,
                    ) || ['', ''])[1]
                  }
                  buttonAriaLabel="代码主题">
                  {CODE_THEME_OPTIONS_SHIKI.map(([value, name]) => {
                    return (
                      <DropDownItem
                        className={`item ${dropDownActiveClass(value === toolbarState.codeTheme)}`}
                        onClick={() => onCodeThemeSelect(value)}
                        key={value}>
                        <span className="text">{name}</span>
                      </DropDownItem>
                    );
                  })}
                </DropDown>
              </>
            )}
          </div>
        ) : (
          <div
            className="toolbar-group toolbar-typography"
            role="group"
            aria-label="字体与字号">
            <FontDropDown
              disabled={!isEditable}
              style={'font-family'}
              value={toolbarState.fontFamily}
              editor={activeEditor}
            />
            <div className="toolbar-font-size" role="group" aria-label="字号">
              <FontSize
                selectionFontSize={parseFontSizeForToolbar(
                  toolbarState.fontSize,
                ).slice(0, -2)}
                editor={activeEditor}
                disabled={!isEditable}
              />
            </div>
          </div>
        )}
      </div>
      <div className="toolbar-secondary">
        <div className="toolbar-group" role="group" aria-label="常用文字格式">
          <button
            disabled={!isEditable}
            onClick={e => dispatchFormatTextCommand('bold', isKeyboardInput(e))}
            className={
              'toolbar-item spaced ' + (toolbarState.isBold ? 'active' : '')
            }
            aria-pressed={toolbarState.isBold}
            title={`加粗 (${shortcut('BOLD')})`}
            type="button"
            aria-label={`加粗，快捷键：${shortcut('BOLD')}`}>
            <i className="format bold" />
          </button>
          <button
            disabled={!isEditable}
            onClick={e =>
              dispatchFormatTextCommand('italic', isKeyboardInput(e))
            }
            className={
              'toolbar-item spaced ' + (toolbarState.isItalic ? 'active' : '')
            }
            aria-pressed={toolbarState.isItalic}
            title={`斜体 (${shortcut('ITALIC')})`}
            type="button"
            aria-label={`斜体，快捷键：${shortcut('ITALIC')}`}>
            <svg className="format-icon" width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M7 3h6M3 13h6M10 3 6 13" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>
          </button>
          <button
            disabled={!isEditable}
            onClick={e =>
              dispatchFormatTextCommand('underline', isKeyboardInput(e))
            }
            className={
              'toolbar-item spaced ' +
              (toolbarState.isUnderline ? 'active' : '')
            }
            aria-pressed={toolbarState.isUnderline}
            title={`下划线 (${shortcut('UNDERLINE')})`}
            type="button"
            aria-label={`下划线，快捷键：${shortcut('UNDERLINE')}`}>
            <i className="format underline" />
          </button>
          <button
            disabled={!isEditable}
            onClick={insertLink}
            className={
              'toolbar-item spaced ' + (toolbarState.isLink ? 'active' : '')
            }
            aria-pressed={toolbarState.isLink}
            aria-label="插入或编辑链接"
            title={`插入或编辑链接 (${shortcut('INSERT_LINK')})`}
            type="button">
            <i className="format link" />
          </button>
        </div>
        <div
          className="toolbar-group toolbar-colors"
          role="group"
          aria-label="文字颜色">
          <DropdownColorPicker
            disabled={!isEditable}
            buttonClassName="toolbar-item color-picker"
            buttonAriaLabel="文字颜色"
            buttonIconClassName="icon font-color"
            color={toolbarState.fontColor}
            onChange={onFontColorSelect}
            title="文字颜色"
          />
          <DropdownColorPicker
            disabled={!isEditable}
            buttonClassName="toolbar-item color-picker"
            buttonAriaLabel="文字背景色"
            buttonIconClassName="icon bg-color"
            color={toolbarState.bgColor}
            onChange={onBgColorSelect}
            title="文字背景色"
          />
        </div>
        <div
          className="toolbar-group toolbar-structure"
          role="group"
          aria-label="段落操作">
          <ElementFormatDropdown
            disabled={!isEditable}
            value={toolbarState.elementFormat}
            editor={activeEditor}
            isRTL={toolbarState.isRTL}
          />
        </div>
        <div
          className="toolbar-group toolbar-more"
          role="group"
          aria-label="其他文字格式">
          <DropDown
            disabled={!isEditable}
            buttonClassName="toolbar-item"
            hideChevron
            buttonLabel=""
            buttonAriaLabel="更多"
            buttonIconClassName="icon toolbar-ellipsis">
            {!toolbarState.isImageCaption && (
              <DropDownItem
                onClick={e =>
                  dispatchFormatTextCommand('code', isKeyboardInput(e))
                }
                className={
                  'item wide ' + dropDownActiveClass(toolbarState.isCode)
                }>
                <div className="icon-text-container">
                  <i className="icon code" />
                  <span className="text">行内代码</span>
                </div>
              </DropDownItem>
            )}
            <DropDownItem onClick={insertRuby} className="item wide">
              <div className="icon-text-container">
                <i className="icon ruby" />
                <span className="text">注音</span>
              </div>
            </DropDownItem>
            <DropDownItem
              onClick={e =>
                dispatchFormatTextCommand('lowercase', isKeyboardInput(e))
              }
              className={
                'item wide ' + dropDownActiveClass(toolbarState.isLowercase)
              }
              title="转为小写"
              aria-label="转为小写">
              <div className="icon-text-container">
                <i className="icon lowercase" />
                <span className="text">转为小写</span>
              </div>
              <span className="shortcut">{shortcut('LOWERCASE')}</span>
            </DropDownItem>
            <DropDownItem
              onClick={e =>
                dispatchFormatTextCommand('uppercase', isKeyboardInput(e))
              }
              className={
                'item wide ' + dropDownActiveClass(toolbarState.isUppercase)
              }
              title="转为大写"
              aria-label="转为大写">
              <div className="icon-text-container">
                <i className="icon uppercase" />
                <span className="text">转为大写</span>
              </div>
              <span className="shortcut">{shortcut('UPPERCASE')}</span>
            </DropDownItem>
            <DropDownItem
              onClick={e =>
                dispatchFormatTextCommand('capitalize', isKeyboardInput(e))
              }
              className={
                'item wide ' + dropDownActiveClass(toolbarState.isCapitalize)
              }
              title="首字母大写"
              aria-label="首字母大写">
              <div className="icon-text-container">
                <i className="icon capitalize" />
                <span className="text">首字母大写</span>
              </div>
              <span className="shortcut">{shortcut('CAPITALIZE')}</span>
            </DropDownItem>
            <DropDownItem
              onClick={e =>
                dispatchFormatTextCommand('strikethrough', isKeyboardInput(e))
              }
              className={
                'item wide ' + dropDownActiveClass(toolbarState.isStrikethrough)
              }
              title="删除线"
              aria-label="删除线">
              <div className="icon-text-container">
                <i className="icon strikethrough" />
                <span className="text">删除线</span>
              </div>
              <span className="shortcut">{shortcut('STRIKETHROUGH')}</span>
            </DropDownItem>
            <DropDownItem
              onClick={e =>
                dispatchFormatTextCommand('subscript', isKeyboardInput(e))
              }
              className={
                'item wide ' + dropDownActiveClass(toolbarState.isSubscript)
              }
              title="下标"
              aria-label="下标">
              <div className="icon-text-container">
                <i className="icon subscript" />
                <span className="text">下标</span>
              </div>
              <span className="shortcut">{shortcut('SUBSCRIPT')}</span>
            </DropDownItem>
            <DropDownItem
              onClick={e =>
                dispatchFormatTextCommand('superscript', isKeyboardInput(e))
              }
              className={
                'item wide ' + dropDownActiveClass(toolbarState.isSuperscript)
              }
              title="上标"
              aria-label="上标">
              <div className="icon-text-container">
                <i className="icon superscript" />
                <span className="text">上标</span>
              </div>
              <span className="shortcut">{shortcut('SUPERSCRIPT')}</span>
            </DropDownItem>
            <DropDownItem
              onClick={e =>
                dispatchFormatTextCommand('highlight', isKeyboardInput(e))
              }
              className={
                'item wide ' + dropDownActiveClass(toolbarState.isHighlight)
              }
              title="高亮"
              aria-label="高亮">
              <div className="icon-text-container">
                <i className="icon highlight" />
                <span className="text">高亮</span>
              </div>
            </DropDownItem>
            <DropDownItem
              onClick={e => clearFormatting(activeEditor, isKeyboardInput(e))}
              className="item wide"
              title="清除格式"
              aria-label="清除所有文字格式">
              <div className="icon-text-container">
                <i className="icon clear" />
                <span className="text">清除格式</span>
              </div>
              <span className="shortcut">{shortcut('CLEAR_FORMATTING')}</span>
            </DropDownItem>
            <Divider />
            <DropDownItem
              onClick={() => editor.dispatchCommand(TOGGLE_COMMENTS_COMMAND)}
              className="item wide">
              <div className="icon-text-container">
                <i className="icon add-comment" />
                <span className="text">查看评论</span>
              </div>
            </DropDownItem>
          </DropDown>
        </div>
        {canViewerSeeInsertDropdown && (
          <div
            className="toolbar-group toolbar-insert"
            role="group"
            aria-label="插入内容">
            <DropDown
              disabled={!isEditable}
              buttonClassName="toolbar-item insert-menu"
              buttonLabel="插入"
              buttonAriaLabel="插入内容"
              buttonIconClassName="icon plus">
              <DropDownItem
                onClick={() => {
                  showModal('插入表格', onClose => (
                    <InsertTableDialog
                      activeEditor={activeEditor}
                      onClose={onClose}
                    />
                  ));
                }}
                className="item">
                <i className="icon table" />
                <span className="text">表格</span>
              </DropDownItem>
              <DropDownItem
                onClick={() =>
                  dispatchToolbarCommand(INSERT_HORIZONTAL_RULE_COMMAND)
                }
                className="item">
                <i className="icon horizontal-rule" />
                <span className="text">分隔线</span>
              </DropDownItem>

              <DropDownItem
                onClick={() => {
                  showModal('插入图片', onClose => (
                    <InsertImageDialog
                      activeEditor={activeEditor}
                      onClose={onClose}
                    />
                  ));
                }}
                className="item">
                <i className="icon image" />
                <span className="text">图片</span>
              </DropDownItem>

              <DropDownItem
                onClick={() =>
                  dispatchToolbarCommand(INSERT_EXCALIDRAW_COMMAND)
                }
                className="item">
                <i className="icon diagram-2" />
                <span className="text">绘图</span>
              </DropDownItem>

              <DropDownItem
                onClick={() => {
                  showModal('插入分栏', onClose => (
                    <InsertLayoutDialog
                      activeEditor={activeEditor}
                      onClose={onClose}
                    />
                  ));
                }}
                className="item">
                <i className="icon columns" />
                <span className="text">分栏布局</span>
              </DropDownItem>

              <DropDownItem
                onClick={() => {
                  showModal('插入公式', onClose => (
                    <InsertEquationDialog
                      activeEditor={activeEditor}
                      onClose={onClose}
                    />
                  ));
                }}
                className="item">
                <i className="icon equation" />
                <span className="text">公式</span>
              </DropDownItem>

              <DropDownItem
                onClick={() =>
                  dispatchToolbarCommand(INSERT_COLLAPSIBLE_COMMAND)
                }
                className="item">
                <i className="icon caret-right" />
                <span className="text">折叠区块</span>
              </DropDownItem>
              <DropDownItem
                onClick={() => {
                  const dateTime = new Date();
                  dateTime.setHours(0, 0, 0, 0);
                  dispatchToolbarCommand(INSERT_DATETIME_COMMAND, {dateTime});
                }}
                className="item">
                <i className="icon calendar" />
                <span className="text">日期</span>
              </DropDownItem>
            </DropDown>
          </div>
        )}
      </div>

      {modal}
    </div>
  );
}
