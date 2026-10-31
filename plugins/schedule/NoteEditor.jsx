import { useEffect, useRef, useState } from 'react';
import { Bold, Code, Heading2, Italic, Link2, List, Quote, Strikethrough } from 'lucide-react';
import { htmlToMarkdown, renderMarkdown } from './markdown.js';

/**
 * 备注正文的排版。插件目录会被 Tailwind 的 @source 扫到，所以这些任意变体都会生成；
 * 不往宿主 CSS 里加插件专属的类，插件删掉时也不会留下死样式。
 */
const NOTE_BODY_CLASS = [
  'text-[12.5px] leading-[1.65] break-words',
  '[&_p]:my-[0.35em] [&_p:first-child]:mt-0 [&_p:last-child]:mb-0',
  '[&_h1]:my-[0.5em] [&_h1]:text-[1.2em] [&_h1]:font-semibold',
  '[&_h2]:my-[0.5em] [&_h2]:text-[1.1em] [&_h2]:font-semibold',
  '[&_h3]:my-[0.5em] [&_h3]:font-semibold',
  '[&_strong]:font-semibold [&_em]:italic [&_del]:line-through',
  '[&_a]:text-info [&_a]:underline [&_a]:underline-offset-2',
  '[&_ul]:my-[0.35em] [&_ul]:list-disc [&_ul]:pl-[1.3em]',
  '[&_ol]:my-[0.35em] [&_ol]:list-decimal [&_ol]:pl-[1.3em]',
  '[&_li]:my-[0.12em]',
  '[&_code]:rounded-sm [&_code]:bg-overlay [&_code]:px-[0.35em] [&_code]:py-[0.1em] [&_code]:font-mono [&_code]:text-[0.94em]',
  '[&_pre]:my-[0.45em] [&_pre]:overflow-x-auto [&_pre]:rounded-md [&_pre]:bg-overlay [&_pre]:p-[0.55em]',
  '[&_pre_code]:bg-transparent [&_pre_code]:p-0',
  '[&_blockquote]:my-[0.45em] [&_blockquote]:border-l-2 [&_blockquote]:border-line [&_blockquote]:pl-[0.7em] [&_blockquote]:text-fg-soft',
  '[&_hr]:my-[0.6em] [&_hr]:border-line',
].join(' ');

const HEADING_RE = /^H[1-6]$/;

/** 行内标记：敲完闭合符立刻变成对应元素（所见即所得的关键一步） */
const INLINE_RULES = [
  { re: /\*\*([^*\n]+)\*\*$/, tag: 'strong' },
  { re: /~~([^~\n]+)~~$/, tag: 'del' },
  { re: /`([^`\n]+)`$/, tag: 'code' },
  { re: /\*([^*\n]+)\*$/, tag: 'em', guard: (before, match) => before[match.index - 1] !== '*' },
];

/**
 * 备注编辑器：contenteditable 里直接显示排版结果，底层数据仍是 Markdown。
 *
 * 两个必须遵守的约束：
 * 1. 输入过程中绝不重写 innerHTML（会把光标顶回开头），只在 DOM 上做最小改动；
 * 2. 标记转换必须在 `beforeinput` 里 preventDefault 后自己做 —— 在 `input` 阶段改 DOM 的话，
 *    浏览器随后会把自己的「打字位置」写回选区，光标就跑到刚生成的元素里面去了。
 */
export function NoteEditor({ value, onChange, placeholder = '可选', ariaLabel = '备注', className = '' }) {
  const ref = useRef(null);
  /** 上一次由本组件写出去的 Markdown，用来区分「外部改值」与「自己刚敲的」 */
  const lastValue = useRef(null);
  const [empty, setEmpty] = useState(value.trim() === '');

  useEffect(() => {
    const el = ref.current;
    if (!el || value === lastValue.current) return;
    lastValue.current = value;
    el.innerHTML = renderMarkdown(value);
    setEmpty(value.trim() === '');
  }, [value]);

  function emit() {
    const el = ref.current;
    if (!el) return;
    const markdown = htmlToMarkdown(el);
    lastValue.current = markdown;
    setEmpty(markdown.trim() === '');
    if (markdown !== value) onChange(markdown);
  }

  /** 光标位置（必须是折叠选区，且落在编辑器内） */
  function caretNode() {
    const editor = ref.current;
    const sel = window.getSelection();
    if (!editor || !sel || sel.rangeCount === 0) return null;
    const range = sel.getRangeAt(0);
    if (!range.collapsed || !editor.contains(range.startContainer)) return null;
    return range.startContainer;
  }

  function caretRange() {
    const sel = window.getSelection();
    return sel && sel.rangeCount > 0 ? sel.getRangeAt(0) : null;
  }

  function elementOf(node) {
    if (!node) return null;
    return node.nodeType === 1 ? node : node.parentElement;
  }

  function inCode(node) {
    return !!elementOf(node)?.closest('code, pre');
  }

  function placeCaret(node, atEnd) {
    const sel = window.getSelection();
    if (!sel) return;
    const range = document.createRange();
    if (node.nodeType === 3) range.setStart(node, atEnd ? (node.textContent ?? '').length : 0);
    else {
      range.selectNodeContents(node);
      range.collapse(!atEnd);
    }
    // 文本节点分支只挪了起点，这里统一收起选区
    range.collapse(true);
    sel.removeAllRanges();
    sel.addRange(range);
  }

  /**
   * 造一个「等着输入」的空白块：先塞一个占位 <br>，光标再落到块首。
   * Blink 会把空元素上的光标规整到元素外面（接着输入就跑到块外去了），必须给个落脚点。
   */
  function createBlock(tag) {
    const el = document.createElement(tag);
    el.appendChild(document.createElement('br'));
    return el;
  }

  /**
   * 行内标记：光标处正好补齐了闭合符就把整段标记换成元素（`data` 是本次待插入的字符）。
   * 命中时调用方会 preventDefault，字符由转换结果替代，不再进入 DOM。
   */
  function convertInline(data) {
    const node = caretNode();
    const range = caretRange();
    if (!node || !range || node.nodeType !== 3 || inCode(node)) return false;
    const parent = node.parentNode;
    if (!parent) return false;

    const text = node.textContent ?? '';
    const before = text.slice(0, range.startOffset) + data;

    for (const rule of INLINE_RULES) {
      const match = rule.re.exec(before);
      if (!match) continue;
      const content = match[1];
      if (content.trim() === '') continue;
      if (rule.guard && !rule.guard(before, match)) continue;

      const el = document.createElement(rule.tag);
      el.textContent = content;
      // 光标之后可能还有内容，拆成尾节点一起回填
      const tail = document.createTextNode(text.slice(range.startOffset));
      node.textContent = before.slice(0, match.index);
      parent.insertBefore(el, node.nextSibling);
      parent.insertBefore(tail, el.nextSibling);
      // 尾节点为空时它并不是合法的光标位置（Blink 会跳过空文本节点），用零宽空格当锚点
      if (tail.data === '') tail.data = '\u200b';
      placeCaret(tail, false);
      if (tail.data === '\u200b') {
        const next = caretRange();
        next?.setStart(tail, 1);
        next?.collapse(true);
      }
      return true;
    }
    return false;
  }

  /** 行首块级标记：# 标题 / - 列表 / 1. 有序 / > 引用（空块里敲出标记 + 空格就生效） */
  function convertBlock(data) {
    const node = caretNode();
    const editor = ref.current;
    if (!node || !editor || inCode(node)) return false;

    // 光标所在的顶层块：首行是裸文本节点，回车之后才被套进 <p> / <div>
    let block = node;
    while (block.parentNode && block.parentNode !== editor) block = block.parentNode;
    if (block.parentNode !== editor) return false;
    if (block.nodeType === 1) {
      const tag = block.tagName;
      if (tag !== 'P' && tag !== 'DIV' && !HEADING_RE.test(tag)) return false;
    }

    // Chrome 在行尾敲空格会写成 &nbsp;（不折叠），否则「# 」这类标记永远匹配不上
    const text = (block.textContent ?? '').replace(/\u00a0/g, ' ') + data;
    const heading = /^(#{1,6}) $/.exec(text);
    let replacement;
    let target;
    if (heading) {
      target = createBlock(`h${heading[1].length}`);
      replacement = target;
    } else if (/^[-*+] $/.test(text) || /^\d+[.)] $/.test(text)) {
      replacement = document.createElement(/^\d+[.)] $/.test(text) ? 'ol' : 'ul');
      target = createBlock('li');
      replacement.appendChild(target);
    } else if (/^> $/.test(text)) {
      replacement = document.createElement('blockquote');
      target = createBlock('p');
      replacement.appendChild(target);
    } else return false;

    block.parentNode?.replaceChild(replacement, block);
    placeCaret(target, false);
    return true;
  }

  /**
   * 每次渲染都重挂一次监听（顺带让闭包拿到最新的 value / onChange，比 ref 转发简单且不易错）。
   * 转换只在「普通字符输入」时做，IME 组字过程（insertCompositionText）不碰。
   */
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onBeforeInput = (event) => {
      const input = event;
      // 组字（IME）期间绝不能改 DOM 或 preventDefault，否则会把候选字吞掉
      if (input.inputType !== 'insertText' || !input.data || input.isComposing) return;
      if (convertInline(input.data) || convertBlock(input.data)) {
        input.preventDefault();
        emit();
      }
    };
    el.addEventListener('beforeinput', onBeforeInput);
    return () => el.removeEventListener('beforeinput', onBeforeInput);
  });

  /** 按段落切开：光标之后的内容整段搬到新块里，光标跟着过去（标题行回车后新块是普通段落） */
  function splitBlock(block) {
    const range = caretRange();
    if (!range) return;
    const rest = document.createRange();
    rest.setStart(range.startContainer, range.startOffset);
    rest.setEnd(block, block.childNodes.length);
    const moved = rest.extractContents();

    const next = document.createElement(block.tagName === 'LI' ? 'li' : 'p');
    next.appendChild(moved);
    // extractContents 会把光标之后的空文本节点也搬过来，normalize 清掉它，
    // 否则 next.firstChild 非空就补不上占位 <br>，光标又会落回上一个块里
    next.normalize();
    if (!next.firstChild) next.appendChild(document.createElement('br'));
    block.parentNode?.insertBefore(next, block.nextSibling);
    placeCaret(next, false);
    emit();
  }

  /** 列表里的回车：空条目退出列表，否则拆一个新条目（不依赖浏览器的默认动作） */
  function enterInList(li) {
    if ((li.textContent ?? '').trim() === '') {
      const list = li.closest('ul, ol');
      const paragraph = createBlock('p');
      list?.parentNode?.insertBefore(paragraph, list.nextSibling);
      li.remove();
      if (list && !list.querySelector('li')) list.remove();
      placeCaret(paragraph, false);
      emit();
      return;
    }
    splitBlock(li);
  }

  function handleKeyDown(event) {
    if (event.key === 'Enter' && !event.shiftKey) {
      // 注意 event.target 永远是获得焦点的编辑器本身，判断「光标在哪种块里」必须看选区
      const start = elementOf(caretNode());
      const li = start?.closest('li');
      if (li) {
        event.preventDefault();
        enterInList(li);
        return;
      }
      // 回车 = 另起一段（Shift+Enter 才是块内换行，交给浏览器插 <br>）
      const block = start?.closest('p, div, h1, h2, h3, h4, h5, h6');
      if (!block) return;
      event.preventDefault();
      // 首行还是裸文本节点（没有任何块级容器）时，让浏览器自己按段落切开
      if (block === ref.current) {
        document.execCommand('insertParagraph');
        emit();
        return;
      }
      splitBlock(block);
      return;
    }
    if ((event.metaKey || event.ctrlKey) && ['b', 'i', 'u'].includes(event.key.toLowerCase())) {
      // 加粗 / 斜体 / 下划线由 contenteditable 原生处理，这里只补一次 Markdown 同步
      setTimeout(emit, 0);
    }
  }

  function handlePaste(event) {
    event.preventDefault();
    const text = event.clipboardData.getData('text/plain').replace(/\r\n?/g, '\n');
    if (!text) return;
    // 只贴纯文本：外部富文本的结构与样式序列化不出干净的 Markdown
    text.split('\n').forEach((line, index) => {
      if (index > 0) document.execCommand('insertLineBreak');
      if (line) document.execCommand('insertText', false, line);
    });
    emit();
  }

  function run(command, arg) {
    ref.current?.focus();
    document.execCommand(command, false, arg);
    emit();
  }

  /** 用元素包住选区（收起的选区就插一个空元素，接着输入即落在里面） */
  function wrapSelection(tag, href) {
    const editor = ref.current;
    const sel = window.getSelection();
    if (!editor) return;
    editor.focus();
    if (!sel || sel.rangeCount === 0) return;
    const range = sel.getRangeAt(0);
    if (!editor.contains(range.commonAncestorContainer)) return;

    const el = document.createElement(tag);
    if (href) el.setAttribute('href', href);
    const needsPlaceholder = range.collapsed && !href;
    if (needsPlaceholder) el.appendChild(document.createElement('br'));
    else if (range.collapsed) el.textContent = href ?? '';
    else el.appendChild(range.extractContents());
    range.insertNode(el);
    placeCaret(el, !needsPlaceholder);
    emit();
  }

  function addLink() {
    const input = window.prompt('链接地址', 'https://');
    const url = input?.trim();
    if (!url) return;
    wrapSelection('a', /^(https?:|mailto:)/i.test(url) ? url : `https://${url}`);
  }

  const buttons = [
    { label: '加粗', icon: Bold, run: () => run('bold') },
    { label: '斜体', icon: Italic, run: () => run('italic') },
    { label: '删除线', icon: Strikethrough, run: () => run('strikeThrough') },
    { label: '行内代码', icon: Code, run: () => wrapSelection('code') },
    { label: '标题', icon: Heading2, run: () => run('formatBlock', 'H2') },
    { label: '列表', icon: List, run: () => run('insertUnorderedList') },
    { label: '引用', icon: Quote, run: () => run('formatBlock', 'BLOCKQUOTE') },
    { label: '链接', icon: Link2, run: addLink },
  ];

  return (
    <div
      className={`rounded-md border border-line bg-canvas transition-colors focus-within:border-line-strong ${className}`}
    >
      <div className="flex flex-wrap items-center gap-0.5 border-b border-line-soft px-1 py-1">
        {buttons.map(({ label, icon: Icon, run: exec }) => (
          <button
            key={label}
            type="button"
            title={label}
            aria-label={label}
            // mousedown 只负责挡住「点击按钮会让编辑器失焦」，命令留给 click —— 这样
            // 键盘 / 辅助技术触发的 click（没有 mousedown）同样有效，且选区已被保住
            onMouseDown={(event) => event.preventDefault()}
            onClick={exec}
            className="flex size-6 items-center justify-center rounded-sm text-fg-muted transition-colors hover:bg-overlay hover:text-fg-max"
          >
            <Icon size={13} />
          </button>
        ))}
      </div>

      <div className="relative">
        <div
          ref={ref}
          contentEditable
          suppressContentEditableWarning
          role="textbox"
          aria-multiline="true"
          aria-label={ariaLabel}
          onInput={emit}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
          onBlur={emit}
          className={`${NOTE_BODY_CLASS} min-h-[92px] max-h-[220px] overflow-y-auto px-2.5 py-2 text-fg-strong outline-none`}
        />
        {empty && (
          <span className="pointer-events-none absolute left-2.5 top-2 text-[12px] text-fg-dim">{placeholder}</span>
        )}
      </div>
    </div>
  );
}
