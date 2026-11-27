/** Accept `host:port`, `http(s)://host`, `ws(s)://host/ws` and normalize both endpoints. */
export function normalizeRelayUrl(input: string): { wsUrl: string; httpUrl: string } {
  const trimmed = input.trim();
  if (!trimmed) throw new Error('relay 地址不能为空');
  const url = new URL(trimmed.includes('://') ? trimmed : `http://${trimmed}`);
  if (url.protocol !== 'http:' && url.protocol !== 'https:' && url.protocol !== 'ws:' && url.protocol !== 'wss:') {
    throw new Error(`不支持的 relay 协议: ${url.protocol}`);
  }
  const secure = url.protocol === 'https:' || url.protocol === 'wss:';
  const httpProtocol = secure ? 'https:' : 'http:';
  const wsProtocol = secure ? 'wss:' : 'ws:';
  let path = url.pathname.replace(/\/+$/, '');
  if (path.endsWith('/ws')) path = path.slice(0, -3);
  const wsUrl = `${wsProtocol}//${url.host}${path}/ws`;
  const httpUrl = `${httpProtocol}//${url.host}${path}`;
  return { wsUrl, httpUrl };
}
