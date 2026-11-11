import {Drawer} from '@arco-design/web-react';
import {type JSX} from 'react';

import {type SettingName} from './appSettings';
import {useSettings} from './context/SettingsContext';
import Switch from './ui/Switch';

const OPTIONS: [SettingName, string][] = [
  ['showTableOfContents', '文档大纲'],
  ['hasNestedTables', '允许嵌套表格'],
  ['hasFitNestedTables', '嵌套表格自适应'],
  ['tableCellMerge', '表格单元格合并'],
  ['tableCellBackgroundColor', '表格单元格背景色'],
  ['tableHorizontalScroll', '表格横向滚动'],
  ['isCodeHighlighted', '代码语法高亮'],
  ['isCodeShiki', '使用 Shiki 高亮'],
  ['isVisibleNonPrinting', '显示不可见字符'],
  ['selectionAlwaysOnDisplay', '保留选区显示'],
  ['selectBlock', '块选择'],
  ['shouldUseLexicalContextMenu', '编辑器右键菜单'],
  ['shouldPreserveNewLinesInMarkdown', 'Markdown 保留换行'],
];

export default function Settings({visible, onClose}: {visible: boolean; onClose: () => void}): JSX.Element {
  const {settings, setOption} = useSettings();
  return (
    <Drawer title="编辑器设置" visible={visible} onCancel={onClose} footer={null} width={340} className="workspace-drawer">
      <p className="settings-intro">只读与 Markdown / HTML 预览位于正文底部。设置不会重建当前文档。</p>
      <div className="settings-options">
        {OPTIONS.map(([key, label]) => <Switch key={key} checked={settings[key]} text={label} onClick={() => setOption(key, !settings[key])} />)}
      </div>
    </Drawer>
  );
}
