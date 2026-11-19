export const MAX_URL_LENGTH = 4096;

/** Interpret a bare hostname as HTTPS, but never turn another scheme into a hostname. */
export function normalizeAddress(value) {
  if (typeof value !== 'string') throw new Error('请输入网址');
  const text = value.trim();
  if (!text || text.length > MAX_URL_LENGTH || /[\s\u0000-\u001f\u007f\\]/u.test(text)) {
    throw new Error('网址为空、过长或包含无效字符');
  }
  // A hostname with a port is not a URI scheme.
  const withScheme = /^[a-z][a-z\d+.-]*:\/\//i.test(text)
    ? text
    : /^[a-z][a-z\d+.-]*:/i.test(text) && !/^[^/:]+:\d+(?:[/?#]|$)/.test(text)
      ? text
      : `https://${text}`;
  let url;
  try { url = new URL(withScheme); } catch { throw new Error('网址格式无效'); }
  if (!['http:', 'https:'].includes(url.protocol) || !url.hostname) throw new Error('只支持 HTTP 或 HTTPS 网址');
  if (url.username || url.password) throw new Error('网址不能包含用户名或密码');
  if (url.href.length > MAX_URL_LENGTH) throw new Error('网址过长');
  return url.href;
}

/** Paths, queries and fragments may contain secrets; only remember the origin. */
export function persistableAddress(value) {
  let url;
  try { url = new URL(normalizeAddress(value)); } catch { return null; }
  return `${url.origin}/`;
}
