import { Marked } from 'marked';

/**
 * 备注在编辑器里的 Markdown ⇄ HTML。
 *
 * 数据里存的始终是 Markdown 本身（不是 HTML）：模型通过 `schedule` 工具读到的备注就是
 * 这段文本，序列化错一个字下次渲染就会变样。渲染用 marked；它在语法上不保证过滤内联
 * HTML，所以这里解析完再过一遍 DOM 消毒（去掉脚本、事件属性、危险协议与图片）。
 */

const marked = new Marked({ gfm: true, breaks: true });

const TEXT_NODE = 3;
const ELEMENT_NODE = 1;

/** 行内需要转义的字符：不转义的话「字面上的星号」下次渲染会变成强调 */
const INLINE_ESCAPE = /([\\`*_[\]~])/g;

function escapeText(text) {
  return text.replace(INLINE_ESCAPE, '\\$1');
}

/** 行首会开启块级语法的字符（# > | - + 1.）单独转义，否则一行普通文字会被解析成列表 / 引用 */
function escapeLineStart(line) {
  const match = /^(\s*)(\S.*)$/.exec(line);
  if (!match) return line;
  const [, pad, rest] = match;
  if (/^[#>|]/.test(rest)) return `${pad}\\${rest}`;
  if (/^[-+]\s/.test(rest) || /^\d+[.)]\s/.test(rest)) {
    return pad + rest.replace(/^([-+]|\d+[.)])/, '\\$1');
  }
  return line;
}

const HEADING_TAGS = /^H[1-6]$/;

const BLOCK_TAGS = new Set(['P', 'DIV', 'UL', 'OL', 'LI', 'BLOCKQUOTE', 'PRE', 'HR', 'TABLE']);

/** 只用于渲染期的消毒：脚本、外链媒体与事件属性都不该从备注里跑进页面 */
function sanitize(html) {
  if (typeof document === 'undefined') return html;
  const template = document.createElement('template');
  template.innerHTML = html;
  for (const el of template.content.querySelectorAll(
    'script,style,iframe,object,embed,link,meta,img,video,audio,svg',
  )) {
    el.remove();
  }
  for (const el of template.content.querySelectorAll('*')) {
    for (const attr of [...el.attributes]) {
      const name = attr.name.toLowerCase();
      if (name.startsWith('on')) {
        el.removeAttribute(attr.name);
      } else if (
        (name === 'href' || name === 'src' || name === 'xlink:href') &&
        /^\s*(javascript|data):/i.test(attr.value)
      ) {
        el.removeAttribute(attr.name);
      }
    }
  }
  return template.innerHTML;
}

/** Markdown → HTML，直接放进 contenteditable。 */
export function renderMarkdown(source) {
  if (!source || source.trim() === '') return '';
  return sanitize(marked.parse(source));
}

/**
 * 编辑器会给「等着用户接着输入的空白块」塞一个占位 <br>（Blink 需要一个有效落脚点，
 * 光标落在空元素上会被规整到元素外面）。这种唯一的子 <br> 不是真换行。
 */
function isPlaceholderBr(node) {
  return !!node.parentNode && node.parentNode.childNodes.length === 1;
}

/** 段落里混进块级子元素时（Chrome 编辑时常套出嵌套 div），这一层要按块递归 */
function hasBlockChild(el) {
  return [...el.children].some((child) => HEADING_TAGS.test(child.tagName) || BLOCK_TAGS.has(child.tagName));
}

function serializeChildrenInline(node) {
  return [...node.childNodes].map(serializeInline).join('');
}

function serializeInline(node) {
  if (node.nodeType === TEXT_NODE) {
    // Chrome 的 contenteditable 会用 &nbsp; 兜住行尾空格，落回 Markdown 时还原成普通空格；
    // 零宽空格只是给光标找位置的锚点，不进数据。
    const text = (node.textContent ?? '').replace(/\u00a0/g, ' ').replace(/\u200b/g, '');
    return text
      .split('\n')
      .map((line) => escapeLineStart(escapeText(line)))
      .join('\n');
  }
  if (node.nodeType !== ELEMENT_NODE) return '';

  const el = node;
  switch (el.tagName) {
    case 'BR':
      return isPlaceholderBr(el) ? '' : '\n';
    case 'STRONG':
    case 'B': {
      const inner = serializeChildrenInline(el);
      return inner.trim() === '' ? '' : `**${inner}**`;
    }
    case 'EM':
    case 'I': {
      const inner = serializeChildrenInline(el);
      return inner.trim() === '' ? '' : `*${inner}*`;
    }
    case 'DEL':
    case 'S':
    case 'STRIKE': {
      const inner = serializeChildrenInline(el);
      return inner.trim() === '' ? '' : `~~${inner}~~`;
    }
    case 'CODE': {
      // 内容里有反引号就换双反引号包起来（CommonMark 的写法）
      const code = (el.textContent ?? '').replace(/\u200b/g, '');
      if (code === '') return '';
      const fence = code.includes('`') ? '``' : '`';
      return `${fence}${code}${fence}`;
    }
    case 'A': {
      const href = el.getAttribute('href') ?? '';
      const text = serializeChildrenInline(el).trim();
      if (!href && !text) return '';
      return `[${text || href}](${href})`;
    }
    case 'IMG':
      // 备注里不放图片，直接丢弃（避免贴进来一个外链图片）
      return '';
    default:
      return serializeChildrenInline(el);
  }
}

function serializeList(list, depth, ordered) {
  const pad = '  '.repeat(depth);
  const items = [...list.children].filter((child) => child.tagName === 'LI');
  return items
    .map((li, index) => {
      const marker = ordered ? `${index + 1}. ` : '- ';
      const inner = serializeBlocks(li, depth + 1);
      if (inner === '') return `${pad}${marker.trimEnd()}`;
      const continuation = pad + ' '.repeat(marker.length);
      return inner
        .split('\n')
        .map((line, i) => (i === 0 ? pad + marker + line : line === '' ? '' : continuation + line))
        .join('\n');
    })
    .join('\n');
}

function serializeBlock(el, depth) {
  const tag = el.tagName;
  if (HEADING_TAGS.test(tag)) {
    const text = serializeChildrenInline(el);
    return text.trim() === '' ? '' : `${'#'.repeat(Number(tag[1]))} ${text}`;
  }
  if (tag === 'UL' || tag === 'OL') return serializeList(el, depth, tag === 'OL');
  if (tag === 'BLOCKQUOTE') {
    const inner = serializeBlocks(el, depth);
    if (inner === '') return '';
    return inner
      .split('\n')
      .map((line) => (line === '' ? '>' : `> ${line}`))
      .join('\n');
  }
  if (tag === 'PRE') {
    return `\`\`\`\n${(el.textContent ?? '').replace(/\n$/, '')}\n\`\`\``;
  }
  if (tag === 'HR') return '---';
  if (tag === 'P' || tag === 'DIV') {
    return hasBlockChild(el) ? serializeBlocks(el, depth) : serializeChildrenInline(el);
  }
  // 其它未知元素：带块级子元素就当容器递归，否则当作一个段落
  return hasBlockChild(el) ? serializeBlocks(el, depth) : serializeChildrenInline(el);
}

function serializeBlocks(container, depth) {
  const blocks = [];
  // 顶层的裸文本 / 行内元素 / 换行先并成一段：编辑器里第一行就是裸文本节点，
  // Shift+Enter 插出来的 <br> 也落在同一层，直接跳过会把硬换行退化成段间的空行
  let inline = '';
  const flush = () => {
    if (inline.trim() !== '') blocks.push(inline);
    inline = '';
  };

  for (const node of [...container.childNodes]) {
    if (node.nodeType === TEXT_NODE) {
      inline += serializeInline(node);
      continue;
    }
    if (node.nodeType !== ELEMENT_NODE) continue;

    const el = node;
    if (el.tagName === 'BR') {
      if (!isPlaceholderBr(el)) inline += '\n';
      continue;
    }
    if (BLOCK_TAGS.has(el.tagName) || HEADING_TAGS.test(el.tagName)) {
      flush();
      const text = serializeBlock(el, depth);
      if (text.trim() !== '') blocks.push(text);
      continue;
    }
    inline += serializeInline(el);
  }
  flush();
  return blocks.join('\n\n');
}

/** 序列化出来的围栏代码块：内容必须原样保留，不能被下面的空白归一化动到 */
const FENCE_RE = /(^```[\s\S]*?^```$)/gm;

/**
 * DOM → Markdown：编辑器（contenteditable）每次输入后用它把内容同步回 Markdown 文本，
 * 所以任务数据里存的始终是 Markdown 本身，不是 HTML。
 */
export function htmlToMarkdown(root) {
  return serializeBlocks(root, 0)
    .split(FENCE_RE)
    .map((part) => (part.startsWith('```') ? part : part.replace(/\n{3,}/g, '\n\n').replace(/[ \t]+$/gm, '')))
    .join('')
    .trim();
}
