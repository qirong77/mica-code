/**
 * 自绘光标与选区高亮要用的「插入点」。
 *
 * 组合期（输入法）textarea 的 selection 语义和普通编辑不一样：Chromium 在
 * compositionupdate / beforeinput 阶段把「整个组合串的范围」报成 selectionStart /
 * selectionEnd（用 CDP 驱动真实组合实测：输入 "TODO: n" 后敲 i，这两个事件上读到的是
 * 6..8，而真正的插入点是 8），组合结束才收敛成插入点。
 *
 * 直接读 selectionStart 于是会命中组合串开头：自绘光标在每次按键时向左跳回拼音前面，
 * 块宽按拼音首字母算；区间还会被当成用户选区 —— 拼音整段被高亮、光标被藏起来。
 * 组合期一律按「插入点在组合串末尾」处理，并且不渲染选区。
 *
 * 组合态由 TerminalComposer 的 compositionstart / compositionend 维护后传进来，
 * 这里保持纯函数以便单测。
 */
export function resolveComposerSelection({ selectionStart, selectionEnd, composing }) {
  if (composing) return { start: selectionEnd, end: selectionEnd }
  return { start: selectionStart, end: selectionEnd }
}
