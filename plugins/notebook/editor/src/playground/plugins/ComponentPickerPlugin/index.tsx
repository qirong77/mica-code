/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {$createCodeNode} from '@lexical/code';
import {INSERT_HORIZONTAL_RULE_COMMAND} from '@lexical/extension';
import {
  INSERT_CHECK_LIST_COMMAND,
  INSERT_ORDERED_LIST_COMMAND,
  INSERT_UNORDERED_LIST_COMMAND,
} from '@lexical/list';
import {INSERT_EMBED_COMMAND} from '@lexical/react/LexicalAutoEmbedPlugin';
import {useLexicalComposerContext} from '@lexical/react/LexicalComposerContext';
import {
  LexicalTypeaheadMenuPlugin,
  MenuOption,
  useBasicTypeaheadTriggerMatch,
} from '@lexical/react/LexicalTypeaheadMenuPlugin';
import {$createHeadingNode, $createQuoteNode} from '@lexical/rich-text';
import {$setBlocksType} from '@lexical/selection';
import {INSERT_TABLE_COMMAND} from '@lexical/table';
import {
  $createParagraphNode,
  $getSelection,
  $isRangeSelection,
  FORMAT_ELEMENT_COMMAND,
  type LexicalEditor,
  type TextNode,
} from 'lexical';
import {type JSX, useCallback, useMemo, useState} from 'react';

import useModal from '../../hooks/useModal';
import catTypingGif from '../../images/cat-typing.gif';
import {EmbedConfigs} from '../AutoEmbedPlugin';
import {INSERT_CARD_COMMAND} from '../CardExtension';
import {INSERT_COLLAPSIBLE_COMMAND} from '../CollapsibleExtension';
import {INSERT_DATETIME_COMMAND} from '../DateTimeExtension';
import {InsertEquationDialog} from '../EquationsExtension';
import {INSERT_EXCALIDRAW_COMMAND} from '../ExcalidrawExtension';
import {INSERT_IMAGE_COMMAND, InsertImageDialog} from '../ImagesExtension';
import InsertLayoutDialog from '../LayoutExtension/InsertLayoutDialog';
import {INSERT_PAGE_BREAK} from '../PageBreakExtension';
import {InsertPollDialog} from '../PollExtension';
import {INSERT_PULLQUOTE_COMMAND} from '../PullQuoteExtension';
import {INSERT_REVIEW_COMMAND} from '../ReviewExtension';
import {InsertTableDialog} from '../TablePlugin';

export class ComponentPickerOption extends MenuOption {
  // What shows up in the editor
  title: string;
  // Icon for display
  icon?: JSX.Element;
  // For extra searching.
  keywords: string[];
  // TBD
  keyboardShortcut?: string;
  // What happens when you select this option?
  onSelect: (queryString: string) => void;

  constructor(
    title: string,
    options: {
      icon?: JSX.Element;
      keywords?: string[];
      keyboardShortcut?: string;
      onSelect: (queryString: string) => void;
    },
  ) {
    super(title);
    this.title = title;
    this.keywords = options.keywords || [];
    this.icon = options.icon;
    this.keyboardShortcut = options.keyboardShortcut;
    this.onSelect = options.onSelect.bind(this);
  }
}

export function ComponentPickerMenuItem({
  index,
  isSelected,
  onClick,
  onMouseEnter,
  option,
}: {
  index: number;
  isSelected: boolean;
  onClick: () => void;
  onMouseEnter: () => void;
  option: ComponentPickerOption;
}) {
  let className = 'item';
  if (isSelected) {
    className += ' selected';
  }
  return (
    <li
      key={option.key}
      tabIndex={-1}
      className={className}
      ref={option.setRefElement}
      role="option"
      aria-selected={isSelected}
      id={'typeahead-item-' + index}
      onMouseEnter={onMouseEnter}
      onClick={onClick}>
      {option.icon}
      <span className="text">{option.title}</span>
    </li>
  );
}

export function getDynamicOptions(editor: LexicalEditor, queryString: string) {
  const options: ComponentPickerOption[] = [];

  if (queryString == null) {
    return options;
  }

  const tableMatch = queryString.match(/^([1-9]\d?)(?:x([1-9]\d?)?)?$/);

  if (tableMatch !== null) {
    const rows = tableMatch[1];
    const colOptions = tableMatch[2]
      ? [tableMatch[2]]
      : [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map(String);

    options.push(
      ...colOptions.map(
        columns =>
          new ComponentPickerOption(`${rows}x${columns} 表格 Table`, {
            icon: <i className="icon table" />,
            keywords: ['table', '表格'],
            onSelect: () =>
              editor.dispatchCommand(INSERT_TABLE_COMMAND, {columns, rows}),
          }),
      ),
    );
  }

  return options;
}

export type ShowModal = ReturnType<typeof useModal>[1];

export function getBaseOptions(editor: LexicalEditor, showModal: ShowModal) {
  return [
    new ComponentPickerOption('正文 Paragraph', {
      icon: <i className="icon paragraph" />,
      keywords: ['normal', 'paragraph', 'p', 'text', '正文', '段落', '文本'],
      onSelect: () =>
        editor.update(() => {
          const selection = $getSelection();
          if ($isRangeSelection(selection)) {
            $setBlocksType(selection, () => $createParagraphNode());
          }
        }),
    }),
    ...([1, 2, 3] as const).map(
      n =>
        new ComponentPickerOption(`标题 ${n} Heading ${n}`, {
          icon: <i className={`icon h${n}`} />,
          keywords: ['heading', 'header', `h${n}`, '标题'],
          onSelect: () =>
            editor.update(() => {
              const selection = $getSelection();
              if ($isRangeSelection(selection)) {
                $setBlocksType(selection, () => $createHeadingNode(`h${n}`));
              }
            }),
        }),
    ),
    new ComponentPickerOption('表格 Table', {
      icon: <i className="icon table" />,
      keywords: [
        'table',
        'grid',
        'spreadsheet',
        'rows',
        'columns',
        '表格',
        '行',
        '列',
      ],
      onSelect: () =>
        showModal('插入表格', onClose => (
          <InsertTableDialog activeEditor={editor} onClose={onClose} />
        )),
    }),
    new ComponentPickerOption('有序列表 Numbered List', {
      icon: <i className="icon number" />,
      keywords: ['numbered list', 'ordered list', 'ol', '有序列表', '编号列表'],
      onSelect: () => editor.dispatchCommand(INSERT_ORDERED_LIST_COMMAND),
    }),
    new ComponentPickerOption('无序列表 Bulleted List', {
      icon: <i className="icon bullet" />,
      keywords: ['bulleted list', 'unordered list', 'ul', '无序列表', '项目符号'],
      onSelect: () => editor.dispatchCommand(INSERT_UNORDERED_LIST_COMMAND),
    }),
    new ComponentPickerOption('待办列表 Check List', {
      icon: <i className="icon check" />,
      keywords: ['check list', 'todo list', '待办列表', '任务清单', '复选框'],
      onSelect: () => editor.dispatchCommand(INSERT_CHECK_LIST_COMMAND),
    }),
    new ComponentPickerOption('引用 Quote', {
      icon: <i className="icon quote" />,
      keywords: ['block quote', '引用'],
      onSelect: () =>
        editor.update(() => {
          const selection = $getSelection();
          if ($isRangeSelection(selection)) {
            $setBlocksType(selection, () => $createQuoteNode());
          }
        }),
    }),
    new ComponentPickerOption('代码块 Code', {
      icon: <i className="icon code" />,
      keywords: ['javascript', 'python', 'js', 'codeblock', '代码', '代码块'],
      onSelect: () =>
        editor.update(() => {
          const selection = $getSelection();

          if ($isRangeSelection(selection)) {
            if (selection.isCollapsed()) {
              $setBlocksType(selection, () => $createCodeNode());
            } else {
              // Will this ever happen?
              const textContent = selection.getTextContent();
              const codeNode = $createCodeNode();
              selection.insertNodes([codeNode]);
              selection.insertRawText(textContent);
            }
          }
        }),
    }),
    new ComponentPickerOption('分隔线 Divider', {
      icon: <i className="icon horizontal-rule" />,
      keywords: ['horizontal rule', 'divider', 'hr', '分隔线', '水平线'],
      onSelect: () => editor.dispatchCommand(INSERT_HORIZONTAL_RULE_COMMAND),
    }),
    new ComponentPickerOption('分页符 Page Break', {
      icon: <i className="icon page-break" />,
      keywords: ['page break', 'divider', '分页符', '分页'],
      onSelect: () => editor.dispatchCommand(INSERT_PAGE_BREAK),
    }),
    new ComponentPickerOption('绘图 Excalidraw', {
      icon: <i className="icon diagram-2" />,
      keywords: ['excalidraw', 'diagram', 'drawing', '绘图', '图表', '画板'],
      onSelect: () => editor.dispatchCommand(INSERT_EXCALIDRAW_COMMAND),
    }),
    new ComponentPickerOption('投票 Poll', {
      icon: <i className="icon poll" />,
      keywords: ['poll', 'vote', '投票'],
      onSelect: () =>
        showModal('插入投票', onClose => (
          <InsertPollDialog activeEditor={editor} onClose={onClose} />
        )),
    }),
    ...EmbedConfigs.map(
      embedConfig =>
        new ComponentPickerOption(`嵌入 Embed ${embedConfig.contentName}`, {
          icon: embedConfig.icon,
          keywords: [...embedConfig.keywords, 'embed', '嵌入'],
          onSelect: () =>
            editor.dispatchCommand(INSERT_EMBED_COMMAND, embedConfig.type),
        }),
    ),
    new ComponentPickerOption('日期 Date', {
      icon: <i className="icon calendar" />,
      keywords: ['date', 'calendar', 'time', '日期', '日历', '时间'],
      onSelect: () => {
        const dateTime = new Date();
        dateTime.setHours(0, 0, 0, 0); // Set time to midnight
        editor.dispatchCommand(INSERT_DATETIME_COMMAND, {dateTime});
      },
    }),
    new ComponentPickerOption('今天 Today', {
      icon: <i className="icon calendar" />,
      keywords: [
        'date',
        'calendar',
        'time',
        'today',
        '日期',
        '日历',
        '时间',
        '今天',
      ],
      onSelect: () => {
        const dateTime = new Date();
        dateTime.setHours(0, 0, 0, 0); // Set time to midnight
        editor.dispatchCommand(INSERT_DATETIME_COMMAND, {dateTime});
      },
    }),
    new ComponentPickerOption('明天 Tomorrow', {
      icon: <i className="icon calendar" />,
      keywords: [
        'date',
        'calendar',
        'time',
        'tomorrow',
        '日期',
        '日历',
        '时间',
        '明天',
      ],
      onSelect: () => {
        const dateTime = new Date();
        dateTime.setDate(dateTime.getDate() + 1);
        dateTime.setHours(0, 0, 0, 0); // Set time to midnight
        editor.dispatchCommand(INSERT_DATETIME_COMMAND, {dateTime});
      },
    }),
    new ComponentPickerOption('昨天 Yesterday', {
      icon: <i className="icon calendar" />,
      keywords: [
        'date',
        'calendar',
        'time',
        'yesterday',
        '日期',
        '日历',
        '时间',
        '昨天',
      ],
      onSelect: () => {
        const dateTime = new Date();
        dateTime.setDate(dateTime.getDate() - 1);
        dateTime.setHours(0, 0, 0, 0); // Set time to midnight
        editor.dispatchCommand(INSERT_DATETIME_COMMAND, {dateTime});
      },
    }),
    new ComponentPickerOption('公式 Equation', {
      icon: <i className="icon equation" />,
      keywords: ['equation', 'latex', 'math', '公式', '数学'],
      onSelect: () =>
        showModal('插入公式', onClose => (
          <InsertEquationDialog activeEditor={editor} onClose={onClose} />
        )),
    }),
    new ComponentPickerOption('动图 GIF', {
      icon: <i className="icon gif" />,
      keywords: ['gif', 'animate', 'image', 'file', '动图', '动画', '图片'],
      onSelect: () =>
        editor.dispatchCommand(INSERT_IMAGE_COMMAND, {
          altText: 'Cat typing on a laptop',
          src: catTypingGif,
        }),
    }),
    new ComponentPickerOption('图片 Image', {
      icon: <i className="icon image" />,
      keywords: ['image', 'photo', 'picture', 'file', '图片', '照片', '文件'],
      onSelect: () =>
        showModal('插入图片', onClose => (
          <InsertImageDialog activeEditor={editor} onClose={onClose} />
        )),
    }),
    new ComponentPickerOption('折叠块 Collapsible', {
      icon: <i className="icon caret-right" />,
      keywords: ['collapse', 'collapsible', 'toggle', '折叠块', '折叠', '展开'],
      onSelect: () => editor.dispatchCommand(INSERT_COLLAPSIBLE_COMMAND),
    }),
    new ComponentPickerOption('卡片 Card', {
      icon: <i className="icon caret-right" />,
      keywords: ['card', 'slot', 'named slots', '卡片'],
      onSelect: () => editor.dispatchCommand(INSERT_CARD_COMMAND),
    }),
    new ComponentPickerOption('重点引用 Pull Quote', {
      icon: <i className="icon quote" />,
      keywords: [
        'pull quote',
        'quote',
        'attribution',
        'cite',
        'slot',
        '重点引用',
        '摘引',
        '引言',
        '引用',
      ],
      onSelect: () => editor.dispatchCommand(INSERT_PULLQUOTE_COMMAND),
    }),
    new ComponentPickerOption('评价 Review', {
      icon: <i className="icon star" />,
      keywords: [
        'review',
        'testimonial',
        'rating',
        'stars',
        'react',
        'slot',
        '评价',
        '评分',
      ],
      onSelect: () => editor.dispatchCommand(INSERT_REVIEW_COMMAND),
    }),
    new ComponentPickerOption('分栏 Columns Layout', {
      icon: <i className="icon columns" />,
      keywords: ['columns', 'layout', 'grid', '分栏', '布局'],
      onSelect: () =>
        showModal('插入分栏', onClose => (
          <InsertLayoutDialog activeEditor={editor} onClose={onClose} />
        )),
    }),
    ...(['left', 'center', 'right', 'justify'] as const).map(
      alignment =>
        new ComponentPickerOption(
          `${
            {
              left: '左对齐',
              center: '居中对齐',
              right: '右对齐',
              justify: '两端对齐',
            }[alignment]
          } Align ${alignment}`,
          {
            icon: <i className={`icon ${alignment}-align`} />,
            keywords: ['align', 'justify', alignment, '对齐'],
            onSelect: () =>
              editor.dispatchCommand(FORMAT_ELEMENT_COMMAND, alignment),
          },
        ),
    ),
  ];
}

export default function ComponentPickerMenuPlugin(): JSX.Element {
  const [editor] = useLexicalComposerContext();
  const [modal, showModal] = useModal();
  const [queryString, setQueryString] = useState<string | null>(null);

  const checkForTriggerMatch = useBasicTypeaheadTriggerMatch('/', {
    allowWhitespace: true,
    minLength: 0,
  });

  const options = useMemo(() => {
    const baseOptions = getBaseOptions(editor, showModal);

    if (!queryString) {
      return baseOptions;
    }

    const regex = new RegExp(queryString, 'i');

    return [
      ...getDynamicOptions(editor, queryString),
      ...baseOptions.filter(
        option =>
          regex.test(option.title) ||
          option.keywords.some(keyword => regex.test(keyword)),
      ),
    ];
  }, [editor, queryString, showModal]);

  const onSelectOption = useCallback(
    (
      selectedOption: ComponentPickerOption,
      nodeToRemove: TextNode | null,
      closeMenu: () => void,
      matchingString: string,
    ) => {
      editor.update(() => {
        nodeToRemove?.remove();
        selectedOption.onSelect(matchingString);
        closeMenu();
      });
    },
    [editor],
  );

  return (
    <>
      {modal}
      <LexicalTypeaheadMenuPlugin<ComponentPickerOption>
        onQueryChange={setQueryString}
        onSelectOption={onSelectOption}
        triggerFn={checkForTriggerMatch}
        options={options}
      />
    </>
  );
}
