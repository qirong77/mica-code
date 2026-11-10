import {Menu} from '@arco-design/web-react';
import {type ReactNode} from 'react';

import {type TableContext} from './tableActions';

export type TableMenuKind = 'row' | 'column' | 'more' | 'context';

type Props = {
  kind: TableMenuKind;
  context: TableContext;
  onAction: (action: string) => void;
};

/** One command menu shared by the toolbar, edge handles and right-click. */
export default function TableOperationsMenu({kind, context: c, onAction}: Props) {
  const item = (key: string, label: string, disabled = false, danger = false, hint?: string) => (
    <Menu.Item key={key} disabled={disabled} aria-disabled={disabled} aria-label={label}
      className={danger ? 'table-menu-danger' : undefined}>
      <span>{label}</span>{hint && <span className="table-menu-hint">{hint}</span>}
    </Menu.Item>
  );
  const separator = (key: string) => <div key={key} className="table-menu-separator" role="separator" />;
  const rowItems = (): ReactNode[] => [
    item('row-before', c.selectionRows > 1 ? `在上方插入 ${c.selectionRows} 行` : '在上方插入行'),
    item('row-after', c.selectionRows > 1 ? `在下方插入 ${c.selectionRows} 行` : '在下方插入行'),
    separator('row-insert-separator'),
    item('select-row', '选中整行'),
    item('duplicate-row', '复制选中行', !c.simple, false, c.simple ? undefined : '含合并格不可用'),
    item('move-row-up', '上移一行', !c.simple || c.selectionRows !== 1 || c.minRow === 0),
    item('move-row-down', '下移一行', !c.simple || c.selectionRows !== 1 || c.maxRow === c.rows - 1),
    separator('row-delete-separator'),
    item('delete-row', '删除选中行', false, true, `${c.selectionRows} 行`),
  ];
  const columnItems = (): ReactNode[] => [
    item('column-before', c.selectionColumns > 1 ? `在左侧插入 ${c.selectionColumns} 列` : '在左侧插入列'),
    item('column-after', c.selectionColumns > 1 ? `在右侧插入 ${c.selectionColumns} 列` : '在右侧插入列'),
    separator('column-insert-separator'),
    item('select-column', '选中整列'),
    item('duplicate-column', '复制选中列', !c.simple, false, c.simple ? undefined : '含合并格不可用'),
    item('move-column-left', '左移一列', !c.simple || c.selectionColumns !== 1 || c.minColumn === 0),
    item('move-column-right', '右移一列', !c.simple || c.selectionColumns !== 1 || c.maxColumn === c.columns - 1),
    separator('column-sort-separator'),
    item('sort-asc', '升序排列', !c.simple || c.selectionColumns !== 1),
    item('sort-desc', '降序排列', !c.simple || c.selectionColumns !== 1),
    separator('column-delete-separator'),
    item('delete-column', '删除选中列', false, true, `${c.selectionColumns} 列`),
  ];
  const styleItems = (): ReactNode[] => [
    item('header', c.header ? '取消标题行' : '首行设为标题'),
    item('header-column', c.headerColumn ? '取消标题列' : '首列设为标题'),
    item('stripe', c.striped ? '关闭斑马纹' : '开启斑马纹'),
    separator('table-style-separator'),
    item('freeze-row', c.frozenRows ? '取消首行冻结' : '冻结首行'),
    item('freeze-column', c.frozenColumns ? '取消首列冻结' : '冻结首列'),
    item('equal-width', '平均分布列宽'),
  ];

  return <Menu className="table-operations-menu" mode="pop" selectable={false}
    triggerProps={{className: 'table-operations-submenu'}} onClickMenuItem={key => onAction(key)}>
    {kind === 'row' ? rowItems() : kind === 'column' ? columnItems() : kind === 'more' ? [
      ...styleItems(), separator('more-selection-separator'),
      item('select-table', '选中整个表格'),
      item('clear-content', '清空选中内容', false, false, '保留表格'),
      separator('more-delete-separator'),
      item('delete-table', '删除整个表格', false, true),
    ] : [
      item('merge', '合并单元格', !c.merge),
      item('split', '拆分单元格', !c.split),
      separator('context-cell-separator'),
      <Menu.SubMenu key="rows" title="行操作">{rowItems()}</Menu.SubMenu>,
      <Menu.SubMenu key="columns" title="列操作">{columnItems()}</Menu.SubMenu>,
      <Menu.SubMenu key="align" title="单元格对齐">{[
        item('align:left', '左对齐'), item('align:center', '水平居中'), item('align:right', '右对齐'),
        separator('align-separator'),
        item('valign:top', '顶端对齐'), item('valign:middle', '垂直居中'), item('valign:bottom', '底端对齐'),
      ]}</Menu.SubMenu>,
      <Menu.SubMenu key="styles" title="表格样式">{styleItems()}</Menu.SubMenu>,
      separator('context-selection-separator'),
      item('select-table', '选中整个表格'),
      item('clear-content', '清空选中内容', false, false, '保留表格'),
      separator('context-delete-separator'),
      item('delete-table', '删除整个表格', false, true),
    ]}
  </Menu>;
}
