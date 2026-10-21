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
