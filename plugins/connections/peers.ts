import { isRecord } from '@packages/mica-common/guards.js';
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

export type PeerEntry = { url: string; note: string; kind?: 'web' };
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
  // 普通网页是具体的入口地址，不是 Mica 运行时；同一站点的不同路径也应各自留在清单里。
  const leftWeb = webEntryAddress(a);
  const rightWeb = webEntryAddress(b);
  if (leftWeb || rightWeb) return leftWeb !== null && leftWeb === rightWeb;
  return isSameRuntime(a, b);
}

/**
 * 当前清单被手改过时：非法项丢掉、同 host 去重、超上限截断。
 *
 * 运行时只认 version 1 的当前对象形态，不解析旧地址数组。
 */
export function normalizePeerStore(raw: unknown): PeerStore {
  if (!isRecord(raw) || raw.version !== PEER_STORE_VERSION || !Array.isArray(raw.peers)) {
    return emptyPeerStore();
  }
  const peers: PeerEntry[] = [];
  for (const value of raw.peers) {
    const entry = asPeerEntry(value);
    if (!entry) continue;
    if (peers.some((existing) => samePeerEntry(existing, entry))) continue;
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
export function rememberPeer(store: PeerStore, url: unknown, label?: unknown, kind?: 'web'): PeerStore {
  const entry = asPeerEntry({ url, note: '', kind });
  if (!entry) return store;
  const current = normalizePeerStore(store);
  const existing = current.peers.find((peer) => samePeerEntry(peer, entry));
  // 探活带回来的名字（中转机那台机器的 `label`）只作为「还没有备注」时的默认值：
  // 用户自己起的备注永远优先，重新连接也不会被覆盖。
  const fallback = normalizePeerNote(label);
  const peers = [
    { url: entry.url, note: existing?.note || fallback, ...(entry.kind ? { kind: entry.kind } : {}) },
    ...current.peers.filter((peer) => !samePeerEntry(peer, entry)),
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
  const index = peers.findIndex((peer) => samePeerEntry(peer, { url: target, note: '' }));
  if (index < 0) return store;
  const next = [...peers];
  next[index] = { ...peers[index]!, note: normalizePeerNote(note) };
  return { version: PEER_STORE_VERSION, peers: next };
}

/** 清单里某个地址的那条记录（没有就返回 null）。 */
export function findPeer(store: PeerStore, url: unknown): PeerEntry | null {
  const target = normalizeEntryAddress(url);
  if (!target) return null;
  return normalizePeerStore(store).peers.find((peer) => samePeerEntry(peer, { url: target, note: '' })) ?? null;
}

/**
 * 卡片里要列出来的其他运行时。
 *
 * 当前这台由卡片单独一行标出来，所以不在清单里重复；当前不在本机时，「本机」那个默认
 * 地址也不出现——它已经作为「回到本机」固定在卡片上，列在这里只是同一行写两遍。
 */
export function peerRows(current: unknown, store: PeerStore, localHost?: string): PeerEntry[] {
  const target = normalizeRuntimeAddress(current);
  const entry = normalizeEntryAddress(current);
  const showLocal = localHost ? !samePeer(current, localHost) : !target || !isLoopbackRuntime(target);
  return normalizePeerStore(store).peers.filter((peer) => {
    // 用原始 current 而不是补过端口的 target：页面由中转机托管时它就是那个 origin，
    // 补成 `:8787` 会跟清单里的链接对不上。
    if (entry && samePeer(peer.url, entry)) return false;
    if (showLocal && (isSameRuntime(peer.url, DEFAULT_RUNTIME_URL) || (localHost && samePeer(peer.url, localHost))))
      return false;
    return true;
  });
}

/** 卡片上这一行的名字：起过备注就用备注，否则退回地址的显示名（回环叫 `Local`）。 */
export function peerLabel(peer: PeerEntry): string {
  return peer.note || runtimeLabel(peer.url);
}

function asPeerEntry(value: unknown): PeerEntry | null {
  if (!isRecord(value)) return null;
  // 中转机和普通网页都是「要打开的入口」，必须原样保留路径与查询串；直连运行时才补 8787 丢路径。
  const web = value.kind === 'web';
  const url = web
    ? normalizeEntryAddress(value.url)
    : relayTokenOf(value.url)
      ? normalizeEntryAddress(value.url)
      : normalizeRuntimeAddress(value.url);
  if (!url) return null;
  const kind = web ? 'web' : undefined;
  return { url, note: normalizePeerNote(value.note), ...(kind ? { kind } : {}) };
}

function samePeerEntry(a: PeerEntry, b: PeerEntry): boolean {
  if (a.kind === 'web') return normalizeEntryAddress(a.url) === normalizeEntryAddress(b.url);
  if (b.kind === 'web') return false;
  return samePeer(a.url, b.url);
}

/**
 * 普通网页的清单地址。带路径/查询的地址本身就是网页入口；根地址则用外部域名且没有显式
 * 端口这一特征识别。真正写入网页历史时会带 `kind: 'web'`，这样 localhost 等带端口的网页
 * 也能保留完整入口；没有 kind 的旧项仍按 Mica 运行时地址解析。
 */
function webEntryAddress(value: unknown): string | null {
  if (relayTokenOf(value)) return null;
  const entry = normalizeEntryAddress(value);
  if (!entry) return null;
  let url: URL;
  try {
    url = new URL(entry);
  } catch {
    return null;
  }
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  const internal =
    host === 'localhost' ||
    host === '127.0.0.1' ||
    host === '::1' ||
    host.endsWith('.local') ||
    /^\d{1,3}(\.\d{1,3}){3}$/.test(host);
  const authority = String(value ?? '').trim().replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').split(/[/?#]/)[0] ?? '';
  const explicitPort = /:\d+$/.test(authority) || host.includes(':') && authority.includes(']');
  // 带端口的地址以及内网主机名仍按 Mica 运行时处理，即使入口后面带了路径；探活返回的
  // 普通网页才会把这类地址保留下来。否则旧的运行时链接 `mac.local:9102/files` 会被误当成
  // 网页，导致同一台机器在清单里出现两条记录。
  if (url.pathname !== '/' || url.search || url.hash) return entry;
  if (!internal && !explicitPort) return entry;
  return null;
}

