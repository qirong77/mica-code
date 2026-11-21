export type TableScrollEdges = {hasLeft: boolean; hasRight: boolean};
export type TableViewport = {left: number; top: number; right: number; bottom: number};

/** Ignore the final subpixel of browser scroll rounding. */
export function tableScrollEdges(element: Pick<HTMLElement, 'scrollLeft' | 'scrollWidth' | 'clientWidth'>): TableScrollEdges {
  return {
    hasLeft: element.scrollLeft > 1,
    hasRight: element.scrollWidth - element.clientWidth - element.scrollLeft > 1,
  };
}

/** Portalled fades must obey the same nested clipping as the actual table. */
export function visibleTableViewport(wrapper: HTMLElement): TableViewport | null {
  const doc = wrapper.ownerDocument;
  const win = doc.defaultView;
  const table = wrapper.querySelector('table');
  if (!win || !table || !wrapper.isConnected) return null;
  const tableRect = table.getBoundingClientRect();
  const visible = {
    left: Math.max(0, tableRect.left), top: Math.max(0, tableRect.top),
    right: Math.min(doc.documentElement.clientWidth, tableRect.right),
    bottom: Math.min(doc.documentElement.clientHeight, tableRect.bottom),
  };
  for (let parent: HTMLElement | null = wrapper; parent; parent = parent.parentElement) {
    const style = win.getComputedStyle(parent);
    const clipsX = /^(auto|scroll|hidden|clip)$/.test(style.overflowX);
    const clipsY = /^(auto|scroll|hidden|clip)$/.test(style.overflowY);
    if (!clipsX && !clipsY) continue;
    const rect = parent.getBoundingClientRect();
    const left = rect.left + parent.clientLeft;
    const top = rect.top + parent.clientTop;
    if (clipsX) {
      visible.left = Math.max(visible.left, left);
      visible.right = Math.min(visible.right, left + parent.clientWidth);
    }
    if (clipsY) {
      visible.top = Math.max(visible.top, top);
      visible.bottom = Math.min(visible.bottom, top + parent.clientHeight);
    }
  }
  return visible.right > visible.left && visible.bottom > visible.top ? visible : null;
}
