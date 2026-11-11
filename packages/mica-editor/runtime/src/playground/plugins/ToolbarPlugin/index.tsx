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
import {type Dispatch, Fragment, type JSX, type MouseEvent, type ReactNode, useCallback, useEffect, useState} from 'react';

import {useSettings} from '../../context/SettingsContext';
import {
  blockTypeToBlockName,
  DEFAULT_FONT_SIZE,
  useToolbarState,
} from '../../context/ToolbarContext';
import useModal from '../../hooks/useModal';
import {MenuSeparator} from '../../../../../../mica-config-ui/web/components/ActionMenu';
import ColorPicker from '../../ui/ColorPicker';
import DropDown, {DropDownItem} from '../../ui/DropDown';
import DropdownColorPicker from '../../ui/DropdownColorPicker';
import {isKeyboardInput} from '../../utils/focusUtils';
import {getSelectedNode} from '../../utils/getSelectedNode';
import {INSERT_COLLAPSIBLE_COMMAND} from '../CollapsibleExtension';
import {INSERT_DATETIME_COMMAND} from '../DateTimeExtension';
import {InsertEquationDialog} from '../EquationsExtension';
import {INSERT_EXCALIDRAW_COMMAND} from '../ExcalidrawExtension';
import {InsertImageDialog} from '../ImagesExtension';
import InsertLayoutDialog from '../LayoutExtension/InsertLayoutDialog';
import {$isRubyNode, $toggleRuby} from '../RubyExtension/RubyNode';
import {shortcut} from '../ShortcutsExtension/shortcuts';
import {InsertTableDialog} from '../TablePlugin';
import FontSize, {parseFontSizeForToolbar} from './fontSize';
import {type ToolbarGroup, useAdaptiveToolbar} from './useAdaptiveToolbar';
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
      <BlockFormatItems editor={editor} blockType={blockType} />
    </DropDown>
  );
}

function BlockFormatItems({editor, blockType}: {editor: LexicalEditor; blockType: keyof typeof blockTypeToBlockName}) {
  return (
    <>
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
    </>
  );
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
      <ElementFormatItems editor={editor} isRTL={isRTL} />
    </DropDown>
  );
}

function ElementFormatItems({editor, isRTL}: {editor: LexicalEditor; isRTL: boolean}) {
  return (
    <>
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
      <MenuSeparator />
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
    </>
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

type ToolbarAction = {
  id: string;
  label: string;
  icon: string;
  active?: boolean;
  disabled?: boolean;
  keys?: string;
  onClick: (event: MouseEvent<HTMLButtonElement>) => void;
};

function ActionIcon({icon}: {icon: string}) {
  if (icon === 'undo' || icon === 'redo')
    return (
      <svg
        className="format-icon"
        width="16"
        height="16"
        viewBox="0 0 16 16"
        fill="none"
        aria-hidden="true">
        <path
          d={
            icon === 'undo'
              ? 'm5 3-3 3 3 3M2 6h7a4 4 0 0 1 0 8'
              : 'm11 3 3 3-3 3M14 6H7a4 4 0 0 0 0 8'
          }
          stroke="currentColor"
          strokeWidth="1.4"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    );
  if (icon === 'quote')
    return (
      <svg
        className="format-icon"
        width="16"
        height="16"
        viewBox="0 0 16 16"
        fill="none"
        aria-hidden="true">
        <path
          d="M3 4h4v5H3V4Zm0 5c0 2 1 3 3 3M10 4h4v5h-4V4Zm0 5c0 2 1 3 3 3"
          stroke="currentColor"
          strokeWidth="1.3"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    );
  if (icon === 'horizontal-rule')
    return (
      <svg
        className="format-icon"
        width="16"
        height="16"
        viewBox="0 0 16 16"
        fill="none"
        aria-hidden="true">
        <path
          d="M2 8h12"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
        />
      </svg>
    );
  if (icon === 'italic')
    return (
      <svg
        className="format-icon"
        width="16"
        height="16"
        viewBox="0 0 16 16"
        fill="none"
        aria-hidden="true">
        <path
          d="M7 3h6M3 13h6M10 3 6 13"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
        />
      </svg>
    );
  if (icon === 'clear')
    return (
      <svg
        className="format-icon"
        width="16"
        height="16"
        viewBox="0 0 16 16"
        fill="none"
        aria-hidden="true">
        <path
          d="m9.5 2.5 4 4a1 1 0 0 1 0 1.4L7.4 14H4.5l-2-2a1 1 0 0 1 0-1.4l7-8.1ZM6 6.5l5 5M7 14h7"
          stroke="currentColor"
          strokeWidth="1.3"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    );
  return <i className={`icon ${icon}`} aria-hidden="true" />;
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
  const [morePage, setMorePage] = useState<string | null>(null);
  const {
    settings: {isCodeHighlighted, isCodeShiki},
  } = useSettings();
  const showCodeOptions =
    toolbarState.blockType === 'code' && isCodeHighlighted;
  const groups: ToolbarGroup[] = [
    ...(!toolbarState.isImageCaption
      ? [{id: 'insert', section: 'insert'}]
      : []),
    {id: 'history', section: 'history', priority: 2},
    {id: 'clear', section: 'history', priority: 9},
    ...(toolbarState.blockType in blockTypeToBlockName &&
    activeEditor === editor
      ? [{id: 'paragraph', section: 'typography', priority: 1}]
      : []),
    ...(showCodeOptions
      ? [{id: 'code-options', section: 'typography'}]
      : [
          {id: 'font-family', section: 'typography', priority: 7},
          {id: 'font-size', section: 'typography', priority: 0},
        ]),
    {id: 'emphasis', section: 'format'},
    {id: 'strikethrough', section: 'format', priority: 6},
    {id: 'underline', section: 'format'},
    ...(!toolbarState.isImageCaption
      ? [{id: 'code', section: 'format', priority: 11}]
      : []),
    {id: 'colors', section: 'colors', priority: 3},
    {id: 'alignment', section: 'structure', priority: 4},
    ...(activeEditor === editor
      ? [
          {id: 'lists', section: 'structure', priority: 5},
          {id: 'indent', section: 'structure', priority: 10},
          {id: 'links', section: 'insert-shortcuts', priority: 8},
          {id: 'blocks', section: 'insert-shortcuts', priority: 12},
        ]
      : []),
    {id: 'more', section: 'more'},
  ];
  const {toolbarElementRef, overflowed} = useAdaptiveToolbar(
    groups,
    `${toolbarState.blockType}:${toolbarState.fontFamily}`,
  );
  const toolbarRef = useMergeRefs([
    rovingRef,
    focusManagerRef,
    toolbarElementRef,
  ]);
  const groupProps = (id: string, label: string, className = '') => {
    const index = groups.findIndex(group => group.id === id);
    const previous = groups
      .slice(0, index)
      .filter(group => !overflowed.has(group.id))
      .at(-1);
    return {
      className: `toolbar-group ${className}`.trim(),
      role: 'group',
      'aria-label': label,
      'data-toolbar-group': id,
      'data-overflowed': overflowed.has(id) || undefined,
      'data-section-start':
        (previous && previous.section !== groups[index]?.section) || undefined,
    };
  };

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
  const textAction = (
    id: TextFormatType,
    label: string,
    icon: string,
    active: boolean,
    keys?: string,
  ): ToolbarAction => ({
    id,
    label,
    icon,
    active,
    keys,
    onClick: event => dispatchFormatTextCommand(id, isKeyboardInput(event)),
  });
  const actions = {
    undo: {
      id: 'undo',
      label: '撤销',
      icon: 'undo',
      disabled: !toolbarState.canUndo,
      keys: IS_APPLE ? '⌘Z' : 'Ctrl+Z',
      onClick: (event: MouseEvent<HTMLButtonElement>) =>
        dispatchToolbarCommand(UNDO_COMMAND, undefined, isKeyboardInput(event)),
    },
    redo: {
      id: 'redo',
      label: '重做',
      icon: 'redo',
      disabled: !toolbarState.canRedo,
      keys: IS_APPLE ? '⇧⌘Z' : 'Ctrl+Y',
      onClick: (event: MouseEvent<HTMLButtonElement>) =>
        dispatchToolbarCommand(REDO_COMMAND, undefined, isKeyboardInput(event)),
    },
    clear: {
      id: 'clear',
      label: '清除格式',
      icon: 'clear',
      keys: shortcut('CLEAR_FORMATTING'),
      onClick: (event: MouseEvent<HTMLButtonElement>) =>
        clearFormatting(activeEditor, isKeyboardInput(event)),
    },
    bold: textAction(
      'bold',
      '加粗',
      'bold',
      toolbarState.isBold,
      shortcut('BOLD'),
    ),
    italic: textAction(
      'italic',
      '斜体',
      'italic',
      toolbarState.isItalic,
      shortcut('ITALIC'),
    ),
    strikethrough: textAction(
      'strikethrough',
      '删除线',
      'strikethrough',
      toolbarState.isStrikethrough,
      shortcut('STRIKETHROUGH'),
    ),
    underline: textAction(
      'underline',
      '下划线',
      'underline',
      toolbarState.isUnderline,
      shortcut('UNDERLINE'),
    ),
    code: textAction('code', '行内代码', 'code', toolbarState.isCode),
    lowercase: textAction(
      'lowercase',
      '转为小写',
      'lowercase',
      toolbarState.isLowercase,
      shortcut('LOWERCASE'),
    ),
    uppercase: textAction(
      'uppercase',
      '转为大写',
      'uppercase',
      toolbarState.isUppercase,
      shortcut('UPPERCASE'),
    ),
    capitalize: textAction(
      'capitalize',
      '首字母大写',
      'capitalize',
      toolbarState.isCapitalize,
      shortcut('CAPITALIZE'),
    ),
    subscript: textAction(
      'subscript',
      '下标',
      'subscript',
      toolbarState.isSubscript,
      shortcut('SUBSCRIPT'),
    ),
    superscript: textAction(
      'superscript',
      '上标',
      'superscript',
      toolbarState.isSuperscript,
      shortcut('SUPERSCRIPT'),
    ),
    highlight: textAction(
      'highlight',
      '高亮',
      'highlight',
      toolbarState.isHighlight,
    ),
    ruby: {id: 'ruby', label: '注音', icon: 'ruby', onClick: insertRuby},
    bullet: {
      id: 'bullet',
      label: '无序列表',
      icon: 'bullet-list',
      active: toolbarState.blockType === 'bullet',
      keys: shortcut('BULLET_LIST'),
      onClick: () => formatBulletList(activeEditor, toolbarState.blockType),
    },
    number: {
      id: 'number',
      label: '有序列表',
      icon: 'numbered-list',
      active: toolbarState.blockType === 'number',
      keys: shortcut('NUMBERED_LIST'),
      onClick: () => formatNumberedList(activeEditor, toolbarState.blockType),
    },
    check: {
      id: 'check',
      label: '任务列表',
      icon: 'check-list',
      active: toolbarState.blockType === 'check',
      keys: shortcut('CHECK_LIST'),
      onClick: () => formatCheckList(activeEditor, toolbarState.blockType),
    },
    outdent: {
      id: 'outdent',
      label: '减少缩进',
      icon: toolbarState.isRTL ? 'indent' : 'outdent',
      keys: shortcut('OUTDENT'),
      onClick: (event: MouseEvent<HTMLButtonElement>) =>
        dispatchToolbarCommand(
          OUTDENT_CONTENT_COMMAND,
          undefined,
          isKeyboardInput(event),
        ),
    },
    indent: {
      id: 'indent',
      label: '增加缩进',
      icon: toolbarState.isRTL ? 'outdent' : 'indent',
      keys: shortcut('INDENT'),
      onClick: (event: MouseEvent<HTMLButtonElement>) =>
        dispatchToolbarCommand(
          INDENT_CONTENT_COMMAND,
          undefined,
          isKeyboardInput(event),
        ),
    },
    link: {
      id: 'link',
      label: '插入或编辑链接',
      icon: 'link',
      active: toolbarState.isLink,
      keys: shortcut('INSERT_LINK'),
      onClick: insertLink,
    },
    quote: {
      id: 'quote',
      label: '引用',
      icon: 'quote',
      active: toolbarState.blockType === 'quote',
      keys: shortcut('QUOTE'),
      onClick: () => formatQuote(activeEditor, toolbarState.blockType),
    },
    rule: {
      id: 'rule',
      label: '分隔线',
      icon: 'horizontal-rule',
      onClick: (event: MouseEvent<HTMLButtonElement>) =>
        dispatchToolbarCommand(
          INSERT_HORIZONTAL_RULE_COMMAND,
          undefined,
          isKeyboardInput(event),
        ),
    },
  } satisfies Record<string, ToolbarAction>;
  const actionButton = (action: ToolbarAction) => (
    <button
      key={action.id}
      type="button"
      className={`toolbar-item${action.active ? ' active' : ''}`}
      disabled={!isEditable || action.disabled}
      aria-label={action.label}
      aria-pressed={action.active}
      title={action.keys ? `${action.label} (${action.keys})` : action.label}
      onClick={action.onClick}>
      <ActionIcon icon={action.icon} />
    </button>
  );
  const actionItem = (action: ToolbarAction) => (
    <DropDownItem
      key={action.id}
      className={`item wide ${dropDownActiveClass(!!action.active)}`}
      disabled={!isEditable || action.disabled}
      onClick={action.onClick}>
      <div className="icon-text-container">
        <ActionIcon icon={action.icon} />
        <span className="text">{action.label}</span>
      </div>
      {action.keys && <span className="shortcut">{action.keys}</span>}
    </DropDownItem>
  );
  const pageItem = (page: string, label: string, icon: string) => (
    <DropDownItem
      key={page}
      className="item wide"
      onClick={event => {
        event.preventDefault();
        setMorePage(page);
      }}>
      <div className="icon-text-container">
        <ActionIcon icon={icon} />
        <span className="text">{label}</span>
      </div>
      <span className="toolbar-menu-forward" aria-hidden="true">
        ›
      </span>
    </DropDownItem>
  );
  const overflowContent: Record<string, ReactNode> = {
    history: (
      <>
        {actionItem(actions.undo)}
        {actionItem(actions.redo)}
      </>
    ),
    clear: actionItem(actions.clear),
    paragraph: pageItem('paragraph', '段落样式', 'paragraph'),
    'font-family': pageItem('font-family', '字体', 'font-family'),
    'font-size': pageItem('font-size', '字号', 'font-family'),
    strikethrough: actionItem(actions.strikethrough),
    code: actionItem(actions.code),
    colors: (
      <>
        {pageItem('font-color', '文字颜色', 'font-color')}
        {pageItem('bg-color', '文字背景色', 'bg-color')}
      </>
    ),
    alignment: pageItem('alignment', '对齐与缩进', 'left-align'),
    lists: (
      <>
        {actionItem(actions.bullet)}
        {actionItem(actions.number)}
      </>
    ),
    indent: (
      <>
        {actionItem(actions.outdent)}
        {actionItem(actions.indent)}
      </>
    ),
    links: (
      <>
        {actionItem(actions.check)}
        {actionItem(actions.link)}
      </>
    ),
    blocks: (
      <>
        {actionItem(actions.quote)}
        {actionItem(actions.rule)}
      </>
    ),
  };
  const collapsedGroups = groups.filter(group => overflowed.has(group.id));
  const morePageLabels: Record<string, string> = {
    paragraph: '段落样式',
    'font-family': '字体',
    'font-size': '字号',
    'font-color': '文字颜色',
    'bg-color': '文字背景色',
    alignment: '对齐与缩进',
  };
  // Navigation replaces the current menu instead of stacking another popup.
  useEffect(() => {
    document
      .querySelector<HTMLElement>(
        '.editor-dropdown [data-toolbar-page] [role^="menuitem"]',
      )
      ?.focus({preventScroll: true});
  }, [morePage]);
  const morePageContent =
    morePage === 'paragraph' ? (
      <BlockFormatItems
        editor={activeEditor}
        blockType={toolbarState.blockType}
      />
    ) : morePage === 'alignment' ? (
      <ElementFormatItems editor={activeEditor} isRTL={toolbarState.isRTL} />
    ) : morePage === 'font-family' || morePage === 'font-size' ? (
      (morePage === 'font-family'
        ? FONT_FAMILY_OPTIONS
        : FONT_SIZE_OPTIONS
      ).map(([value, label]) => (
        <DropDownItem
          key={value}
          className={`item ${dropDownActiveClass(value === (morePage === 'font-family' ? toolbarState.fontFamily : toolbarState.fontSize))}`}
          onClick={() => applyStyleText({[morePage]: value})}>
          <span className="text">{label}</span>
        </DropDownItem>
      ))
    ) : morePage === 'font-color' || morePage === 'bg-color' ? (
      <ColorPicker
        compact
        color={
          morePage === 'font-color'
            ? toolbarState.fontColor
            : toolbarState.bgColor
        }
        onChange={
          morePage === 'font-color' ? onFontColorSelect : onBgColorSelect
        }
      />
    ) : null;

  return (
    <div
      ref={toolbarRef}
      className="toolbar"
      role="toolbar"
      aria-label="编辑工具栏">
      {!toolbarState.isImageCaption && (
        <div {...groupProps('insert', '插入内容', 'toolbar-insert')}>
          <DropDown
            disabled={!isEditable}
            buttonClassName="toolbar-item insert-menu"
            hideChevron
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
              onClick={() => dispatchToolbarCommand(INSERT_EXCALIDRAW_COMMAND)}
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
              onClick={() => dispatchToolbarCommand(INSERT_COLLAPSIBLE_COMMAND)}
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
      <div {...groupProps('history', '编辑历史')}>
        {actionButton(actions.undo)}
        {actionButton(actions.redo)}
      </div>
      <div {...groupProps('clear', '清除格式')}>
        {actionButton(actions.clear)}
      </div>
      {toolbarState.blockType in blockTypeToBlockName &&
        activeEditor === editor && (
          <div {...groupProps('paragraph', '段落格式')}>
            <BlockFormatDropDown
              disabled={!isEditable}
              blockType={toolbarState.blockType}
              rootType={toolbarState.rootType}
              editor={activeEditor}
            />
          </div>
        )}
      {showCodeOptions ? (
        <div
          {...groupProps('code-options', '代码选项', 'toolbar-code-options')}>
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
                          normalizeCodeLanguageShiki(toolbarState.codeLanguage),
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
        <>
          <div {...groupProps('font-family', '字体')}>
            <FontDropDown
              disabled={!isEditable}
              style="font-family"
              value={toolbarState.fontFamily}
              editor={activeEditor}
            />
          </div>
          <div {...groupProps('font-size', '字号')}>
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
        </>
      )}
      <div {...groupProps('emphasis', '加粗与斜体')}>
        {actionButton(actions.bold)}
        {actionButton(actions.italic)}
      </div>
      <div {...groupProps('strikethrough', '删除线')}>
        {actionButton(actions.strikethrough)}
      </div>
      <div {...groupProps('underline', '下划线')}>
        {actionButton(actions.underline)}
      </div>
      {!toolbarState.isImageCaption && (
        <div {...groupProps('code', '行内代码')}>
          {actionButton(actions.code)}
        </div>
      )}
      <div {...groupProps('colors', '文字颜色', 'toolbar-colors')}>
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
      <div {...groupProps('alignment', '对齐与缩进')}>
        <ElementFormatDropdown
          disabled={!isEditable}
          value={toolbarState.elementFormat}
          editor={activeEditor}
          isRTL={toolbarState.isRTL}
        />
      </div>
      {activeEditor === editor && (
        <>
          <div {...groupProps('lists', '列表')}>
            {actionButton(actions.bullet)}
            {actionButton(actions.number)}
          </div>
          <div {...groupProps('indent', '段落缩进')}>
            {actionButton(actions.outdent)}
            {actionButton(actions.indent)}
          </div>
          <div {...groupProps('links', '任务与链接')}>
            {actionButton(actions.check)}
            {actionButton(actions.link)}
          </div>
          <div {...groupProps('blocks', '引用与分隔线')}>
            {actionButton(actions.quote)}
            {actionButton(actions.rule)}
          </div>
        </>
      )}
      <div {...groupProps('more', '更多操作', 'toolbar-more')}>
        <DropDown
          disabled={!isEditable}
          buttonClassName="toolbar-item"
          hideChevron
          buttonAriaLabel="更多"
          buttonIconClassName="icon toolbar-ellipsis"
          onOpen={() => setMorePage(null)}
          stopCloseOnClickSelf={
            morePage === 'font-color' || morePage === 'bg-color'
          }>
          <div data-toolbar-page={morePage || 'root'}>
            {morePage ? (
              <>
                <DropDownItem
                  className="item wide toolbar-menu-back"
                  onClick={event => {
                    event.preventDefault();
                    setMorePage(null);
                  }}>
                  <span className="toolbar-menu-back-icon" aria-hidden="true">
                    ‹
                  </span>
                  <span className="text">{morePageLabels[morePage]}</span>
                </DropDownItem>
                <MenuSeparator />
                {morePageContent}
              </>
            ) : (
              <>
                {collapsedGroups.map((group, index) => (
                  <Fragment key={group.id}>
                    {index > 0 &&
                      collapsedGroups[index - 1].section !== group.section && (
                        <MenuSeparator />
                      )}
                    {overflowContent[group.id]}
                  </Fragment>
                ))}
                {collapsedGroups.length > 0 && <MenuSeparator />}
                {[
                  actions.subscript,
                  actions.superscript,
                  actions.highlight,
                  actions.ruby,
                ].map(actionItem)}
                <MenuSeparator />
                {[actions.lowercase, actions.uppercase, actions.capitalize].map(
                  actionItem,
                )}
              </>
            )}
          </div>
        </DropDown>
      </div>
      {modal}
    </div>
  );
}
