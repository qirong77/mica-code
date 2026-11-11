/** Pure textarea edits shared by the runtime source view and the CDN fallback. */
export type MarkdownSourceEdit = {
  start: number;
  end: number;
  text: string;
  selectionStart: number;
  selectionEnd: number;
};

export function planMarkdownSourceIndent(value: string, start: number, end: number, outdent = false): MarkdownSourceEdit | null {
  const lineStart = start > 0 ? value.lastIndexOf('\n', start - 1) + 1 : 0;
  const selected = value.slice(start, end);
  if (!outdent && !selected.includes('\n')) {
    return {start, end, text: '  ', selectionStart: start + 2, selectionEnd: start + 2};
  }
  // An end at the start of the next line does not select that following line.
  const lastOffset = end > start && value[end - 1] === '\n' ? end - 1 : end;
  const newline = value.indexOf('\n', lastOffset);
  const lineEnd = newline < 0 ? value.length : newline;
  const lines = value.slice(lineStart, lineEnd).split('\n');
  const removed = lines.map(line => outdent ? (/^(?: {1,2}|\t)/.exec(line)?.[0].length || 0) : 0);
  if (outdent && removed.every(count => !count)) return null;
  const text = lines.map((line, index) => outdent ? line.slice(removed[index]) : `  ${line}`).join('\n');
  const offsetAfter = (position: number) => {
    let offset = lineStart;
    let delta = 0;
    for (let index = 0; index < lines.length; index++) {
      if (position < offset) break;
      delta += outdent ? -Math.min(removed[index], position - offset) : 2;
      offset += lines[index].length + 1;
    }
    return Math.max(lineStart, position + delta);
  };
  return {start: lineStart, end: lineEnd, text, selectionStart: offsetAfter(start), selectionEnd: offsetAfter(end)};
}

/** setRangeText alone bypasses native undo. Prefer the browser's text transaction. */
export function applyMarkdownSourceEdit(element: HTMLTextAreaElement, edit: MarkdownSourceEdit, onChange: (value: string) => void): void {
  const doc = element.ownerDocument;
  const scrollTop = element.scrollTop, scrollLeft = element.scrollLeft;
  const before = element.value;
  const expected = before.slice(0, edit.start) + edit.text + before.slice(edit.end);
  element.setSelectionRange(edit.start, edit.end);
  try { doc.execCommand('insertText', false, edit.text); } catch { /* DOM-only fallback below. */ }
  if (element.value !== expected) element.setRangeText(edit.text, edit.start, edit.end, 'end');
  onChange(element.value);
  element.setSelectionRange(edit.selectionStart, edit.selectionEnd);
  element.scrollTop = scrollTop;
  element.scrollLeft = scrollLeft;
}
