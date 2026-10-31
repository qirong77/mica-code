/**
 * 自动链接（GFM autolink literal）遇到全角标点时该在哪里断开。
 *
 * 模型经常把 URL 直接写在句子里：「已部署到 http://10.190.46.109:9200。」
 * 两个渲染端的自动链接实现都只认 ASCII 标点：
 * - 桌面用的 micromark（GFM autolink literal）把 `.,;:!?)]` 当可裁剪尾部，
 *   全角句号不在那个集合里，于是被吃进链接，href 变成 `...:9200。`；
 * - CLI 用的 marked 更宽，`[^\s<]*` 会把后面的中文整段吞进去
 *   （`看 https://x/a，然后` 的链接目标是 `https://x/a，然后`）。
 *
 * 所以判定是「在第一个全角标点处截断」，而不是只裁尾部；两个渲染端共用这一份，
 * 新增字符只加这一个集合。
 */
const AUTOLINK_STOP_PUNCTUATION = /[。，、；：！？）】》」』〉〕｝”’…～]/

export type AutolinkPunctuationSplit = {
  /** 截断后的地址（链接目标） */
  url: string;
  /** 截断后的显示文本 */
  text: string;
  /** 被切出来、应当按普通文本排在链接后面的部分（标点及其后的一切） */
  trailing: string;
};

/**
 * 把「链接目标 + 显示文本」在全角标点处拆开。
 *
 * 只有在显示文本也以同一段内容结尾时才拆：显式 markdown 链接
 * `[看这里](http://x。)` 的文本里没有那段字符，若只裁剪目标就会悄悄改掉用户写的
 * 地址，那种情况一律原样保留（返回 null）。
 */
export function splitAutolinkPunctuation(
  url: string,
  text?: string | null,
): AutolinkPunctuationSplit | null {
  const href = String(url ?? '');
  const label = text === undefined || text === null ? href : String(text);
  const index = href.search(AUTOLINK_STOP_PUNCTUATION);
  if (index <= 0) return null;

  const trailing = href.slice(index);
  if (!label.endsWith(trailing)) return null;

  return { url: href.slice(0, index), text: label.slice(0, label.length - trailing.length), trailing };
}

/** 纯文本里识别到的一条链接。`text` 是原文片段，`url` 是点击要打开的目标。 */
export type AutolinkMatch = {
  url: string;
  text: string;
  start: number;
  end: number;
};

// 纯文本里的链接候选：显式协议与 `www.` 前缀（与 GFM autolink literal 认的两种写法
// 对齐）。前导边界排掉字母数字与 URL 自身会出现的字符，免得从词中间切出来。
const AUTOLINK_CANDIDATE = /(?<![A-Za-z0-9_@/.:-])((?:https?:\/\/|www\.)[^\s<>"'`]+)/g;

// 尾部可以直接丢掉的标点：ASCII 句读、引号、全角句读与括号状收尾（括号见下面平衡判断）。
// `*` 与 `_` 也在里面：这两个是强调分隔符，`**http://x/a**` 里尾部那两个不属于地址
// （GFM 自己的 trailing punctuation 同样收 `*` `_` `~`）。
const AUTOLINK_TAIL_PUNCTUATION = /[.,;:!?'"’”…。，、；：！？）〕〉》」』】｝—～*_]/u;
const AUTOLINK_TAIL_PAIRS: ReadonlyArray<readonly [string, string]> = [
  [')', '('],
  [']', '['],
  ['}', '{'],
];

/**
 * 从尾部剥掉不属于地址的字符。
 *
 * 收尾括号要有平衡判断：`(https://x/a)` 里那个 `)` 不属于地址，而
 * `https://en.wikipedia.org/wiki/Foo_(bar)` 里的属于。只按字符集裁会把后者切坏。
 */
function trimAutolinkTail(value: string): string {
  let url = value;
  for (;;) {
    const last = url[url.length - 1];
    if (!last) return url;
    if (AUTOLINK_TAIL_PUNCTUATION.test(last)) {
      url = url.slice(0, -1);
      continue;
    }
    const pair = AUTOLINK_TAIL_PAIRS.find(([close]) => close === last);
    if (pair) {
      const [close, open] = pair;
      let depth = 0;
      for (const character of url) {
        if (character === open) depth += 1;
        else if (character === close) depth -= 1;
      }
      if (depth < 0) {
        url = url.slice(0, -1);
        continue;
      }
    }
    return url;
  }
}

/**
 * 找出纯文本里的链接（`https://…` / `http://…` / `www.…`）。
 *
 * 对话区里只有助手消息走 markdown（GFM 自己会认链接），用户消息、引用块、notice、
 * 思考这些纯文本区域要靠它把 URL 变成可点元素。判定与 `splitAutolinkPunctuation`
 * 同源：全角标点处断开，不留进 href。
 */
export function findAutolinks(text: string): AutolinkMatch[] {
  const source = String(text ?? '');
  if (!source) return [];
  const matches: AutolinkMatch[] = [];
  const pattern = new RegExp(AUTOLINK_CANDIDATE.source, 'g');
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(source))) {
    // 全角标点一刀切：后面跟着的中文不是地址的一部分（`https://x/a，然后`）。
    const stop = match[1].search(AUTOLINK_STOP_PUNCTUATION);
    const raw = trimAutolinkTail(stop >= 0 ? match[1].slice(0, stop) : match[1]);
    if (!raw) continue;
    const url = raw.startsWith('www.') ? `http://${raw}` : raw;
    const start = match.index;
    matches.push({ url, text: raw, start, end: start + raw.length });
  }
  return matches;
}
