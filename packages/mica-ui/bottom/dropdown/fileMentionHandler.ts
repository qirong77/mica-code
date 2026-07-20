import { state } from './state.js';
import type { MicaUiDropdownItem } from '../../types.js';

const FILE_MENTION_TITLE = '文件  ·  ↑↓ 选择  Enter/Tab 插入  Esc 关闭';

export function showFileMentionLoading(): void {
  state.set({
    visible: true,
    items: [],
    selectedIndex: 0,
    title: FILE_MENTION_TITLE,
    emptyMessage: '正在搜索文件…',
    kind: 'file',
  });
}

export function showFileMentions(items: MicaUiDropdownItem[]): void {
  state.set({
    visible: true,
    items,
    selectedIndex: 0,
    title: FILE_MENTION_TITLE,
    emptyMessage: '没有找到匹配文件',
    kind: 'file',
  });
}

export function showFileMentionError(): void {
  state.set({
    visible: true,
    items: [],
    selectedIndex: 0,
    title: FILE_MENTION_TITLE,
    emptyMessage: '文件搜索失败',
    kind: 'file',
  });
}

export function hideFileMentions(): void {
  if (state.get().kind !== 'file') return;
  state.set({ visible: false, items: [], selectedIndex: 0 });
}
