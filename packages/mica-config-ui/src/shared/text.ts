/**
 * 文本体积的粗略换算，两个宿主与浏览器侧共用。
 *
 * 只依赖字符串本身，不碰文件系统 —— 所以 `web/` 下的组件也能直接用它（浏览器侧不许
 * import 会带进 Node 内置模块的入口）。
 */

/**
 * 粗估 token：CJK 字符按 1 token 计，其余字符按 1/4 token 计。
 *
 * 与 CLI 状态栏的 ctx 同口径，用来比较「谁占了 context」，不是真实 tokenizer 的结果。
 */
export function estimateTextTokens(text: string): number {
  const value = typeof text === 'string' ? text : String(text ?? '');
  let cjk = 0;
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (
      (code >= 0x3400 && code <= 0x4dbf) || // CJK Extension A
      (code >= 0x4e00 && code <= 0x9fff) || // CJK Unified
      (code >= 0xf900 && code <= 0xfaff) || // CJK Compatibility
      (code >= 0x3040 && code <= 0x30ff) || // Kana
      (code >= 0xac00 && code <= 0xd7af) || // Hangul
      (code >= 0xff00 && code <= 0xffef) // Full-width forms
    ) {
      cjk++;
    }
  }
  return cjk + Math.ceil((value.length - cjk) / 4);
}
