import {
  DEFAULT_RUNTIME_URL,
  isLoopbackRuntime,
  isSameRuntime,
  normalizeEntryAddress,
  normalizeRuntimeAddress,
  relayTokenOf,
  runtimeLabel,
} from '@packages/mica-web-shared/index.js';

/**
 * 「连接过哪些运行时」的纯数据层。
 *
 * 数据文件由插件前端经宿主的 `plugin-host:read-data|write-data` 读写，宿主不解析结构：
 * 连接清单是插件自己的事，宿主只提供读写。所以这里既没有 I/O 也没有 React，只有
 * 收敛规则——前端拿到的每一份 store 都先过 `normalizePeerStore`，写回去的也是它。
 *
 * 地址怎么规范、哪个是回环、两串是不是同一台，规则都在 `mica-web-shared/runtime-address`：
 * 页面、运行时探活、这份清单必须答得一样，否则「清单里有这条却连不上」会变成
 * 两个模块各说一次的问题。
 */

export const PEER_STORE_VERSION = 1;
/** 清单上限：侧栏卡片是给「几个人少台机器」用的，不是服务器书签管理器。 */
export const MAX_PEERS = 8;
/** 备注只是这条记录认得出来的名字，限长免得把卡片撑变形。 */
export const MAX_PEER_NOTE_LENGTH = 40;

export type PeerEntry = { url: string; note: string };
export type PeerStore = { version: number; peers: PeerEntry[] };

export function emptyPeerStore(): PeerStore {
  return { version: PEER_STORE_VERSION, peers: [] };
}

/**
 * 中转机链接的键：同一个中转机上的同一台机器。
 *
 * 不带 `session` 是有意的——那是「打开哪条会话」，不是「哪台机器」。同一台机器的链接
 * 换了一条会话之后仍然是一条记录，只是记住的入口跟着更新。
 */
function relayKey(value: unknown): string | null {
  const token = relayTokenOf(value);
  if (!token) return null;
  const url = normalizeEntryAddress(value);
  if (!url) return null;
  try {
    return `${new URL(url).origin}|${token}`;
  } catch {
    return null;
  }
}

/**
 * 两条记录是不是同一台机器。
 *
 * 直连地址照旧按 host 比（`192.168.1.5` 与 `http://192.168.1.5:8787` 是同一台）；
 * 中转机链接按「中转机 + 令牌」比，因为它背后那台机器的 origin 根本不在链接里。
 * 裸 origin 没有机器身份，不能把它与该中转机背后的任意一台机器合并。
 */
export function samePeer(a: unknown, b: unknown): boolean {
  const left = relayKey(a);
  const right = relayKey(b);
  if (left && right) return left === right;
  if (left || right) return false;
  return isSameRuntime(a, b);
}

/**
 * 读出来的清单可能是旧版本或被手改过的：非法项丢掉、同 host 去重、超上限截断。
 *
 * 旧版本存的是纯地址数组（`["http://10.0.0.2:9102"]`），这里一并读成
 * `{ url, note: '' }`——下一次写入就是新格式，不需要单独的迁移步骤。
 */
export function normalizePeerStore(raw: unknown): PeerStore {
  const peers: PeerEntry[] = [];
  for (const value of readPeerList(raw)) {
    const candidate = typeof value === 'string' ? { url: value, note: '' } : value;
    const entry = asPeerEntry(candidate);
    if (!entry) continue;
    if (peers.some((existing) => samePeer(existing.url, entry.url))) continue;
    peers.push(entry);
    if (peers.length >= MAX_PEERS) break;
  }
  return { version: PEER_STORE_VERSION, peers };
}

/** 备注是单行文本：折叠空白、去首尾、限长（与旧的页面清单保持同一套规则）。 */
export function normalizePeerNote(value: unknown): string {
  if (typeof value !== 'string') return '';
  return value.replace(/\s+/g, ' ').trim().slice(0, MAX_PEER_NOTE_LENGTH);
}

/**
 * 记一台连上的运行时：排到最前，备注保留。
 *
 * 备注属于这台机器（「办公室的 Mac」不会因为又连了一次就不成立），所以重新连接只调整
 * 位置。地址非法时原样返回 store，调用方照旧渲染。
 */
export function rememberPeer(store: PeerStore, url: unknown, label?: unknown): PeerStore {
  const entry = asPeerEntry({ url, note: '' });
  if (!entry) return store;
  const current = normalizePeerStore(store);
  const existing = current.peers.find((peer) => samePeer(peer.url, entry.url));
  // 探活带回来的名字（中转机那台机器的 `label`）只作为「还没有备注」时的默认值：
  // 用户自己起的备注永远优先，重新连接也不会被覆盖。
  const fallback = normalizePeerNote(label);
  const peers = [
    { url: entry.url, note: existing?.note || fallback },
    ...current.peers.filter((peer) => !samePeer(peer.url, entry.url)),
  ];
  return { version: PEER_STORE_VERSION, peers: peers.slice(0, MAX_PEERS) };
}

/**
 * 改某条记录的备注。成员只由 `rememberPeer` 加，所以地址不在清单里时原样返回：
 * 没有这一条就无处安放备注，也不该凭一个备注把没连过的地址记进来。
 */
export function setPeerNote(store: PeerStore, url: unknown, note: unknown): PeerStore {
  // 先规范化再比：用户可能只写 `10.0.0.2:9102`，而清单里存的是补过协议的地址
  const target = normalizeEntryAddress(url);
  if (!target) return store;
  const peers = normalizePeerStore(store).peers;
  const index = peers.findIndex((peer) => samePeer(peer.url, target));
  if (index < 0) return store;
  const next = [...peers];
  next[index] = { url: peers[index]!.url, note: normalizePeerNote(note) };
  return { version: PEER_STORE_VERSION, peers: next };
}

/** 清单里某个地址的那条记录（没有就返回 null）。 */
export function findPeer(store: PeerStore, url: unknown): PeerEntry | null {
  const target = normalizeEntryAddress(url);
  if (!target) return null;
  return normalizePeerStore(store).peers.find((peer) => samePeer(peer.url, target)) ?? null;
}

/**
 * 卡片里要列出来的其他运行时。
 *
 * 当前这台由卡片单独一行标出来，所以不在清单里重复；当前不在本机时，「本机」那个默认
 * 地址也不出现——它已经作为「回到本机」固定在卡片上，列在这里只是同一行写两遍。
 */
export function peerRows(current: unknown, store: PeerStore): PeerEntry[] {
  const target = normalizeRuntimeAddress(current);
  const entry = normalizeEntryAddress(current);
  const showLocal = !target || !isLoopbackRuntime(target);
  return normalizePeerStore(store).peers.filter((peer) => {
    // 用原始 current 而不是补过端口的 target：页面由中转机托管时它就是那个 origin，
    // 补成 `:8787` 会跟清单里的链接对不上。
    if (entry && samePeer(peer.url, entry)) return false;
    if (showLocal && isSameRuntime(peer.url, DEFAULT_RUNTIME_URL)) return false;
    return true;
  });
}

/** 卡片上这一行的名字：起过备注就用备注，否则退回地址的显示名（回环叫 `Local`）。 */
export function peerLabel(peer: PeerEntry): string {
  return peer.note || runtimeLabel(peer.url);
}

/** 混进来的可能是数组、可能是 `{ peers: [...] }`，也可能是一句无意义的字符串。 */
function readPeerList(raw: unknown): unknown[] {
  if (Array.isArray(raw)) return raw;
  if (isRecord(raw) && Array.isArray(raw.peers)) return raw.peers;
  return [];
}

function asPeerEntry(value: unknown): PeerEntry | null {
  if (!isRecord(value)) return null;
  // 中转机链接必须原样保留（`t` 与 `session` 都在查询串里），直连地址才补 8787 丢路径
  const url = relayTokenOf(value.url) ? normalizeEntryAddress(value.url) : normalizeRuntimeAddress(value.url);
  if (!url) return null;
  return { url, note: normalizePeerNote(value.note) };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
