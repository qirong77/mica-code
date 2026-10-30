import { describe, expect, it } from 'vitest';
import {
  MAX_PEER_NOTE_LENGTH,
  MAX_PEERS,
  PEER_STORE_VERSION,
  emptyPeerStore,
  findPeer,
  normalizePeerStore,
  peerRows,
  rememberPeer,
  setPeerNote,
} from './peers.js';

const store = (peers: unknown[]) => normalizePeerStore({ version: PEER_STORE_VERSION, peers });

describe('normalizePeerStore', () => {
  it('缺字段与垃圾输入都收敛成一份可用的空表', () => {
    for (const raw of [undefined, null, 42, 'nope', {}, { peers: 'nope' }]) {
      expect(normalizePeerStore(raw)).toEqual({ version: PEER_STORE_VERSION, peers: [] });
      expect(emptyPeerStore()).toEqual({ version: PEER_STORE_VERSION, peers: [] });
    }
  });

  it('给裸地址补上默认端口、丢掉路径，显式端口原样保留', () => {
    expect(store([{ url: '10.0.0.2' }, { url: 'http://mac.local:9102/files' }])).toEqual({
      version: PEER_STORE_VERSION,
      peers: [
        { url: 'http://10.0.0.2:8787', note: '' },
        { url: 'http://mac.local:9102', note: '' },
      ],
    });
  });

  it('丢掉非法项，并按 host:port 去重（第一份记录胜出）', () => {
    expect(
      store([
        { url: 'http://10.0.0.2:9102', note: '办公室' },
        { url: '10.0.0.2:9102', note: '重复' },
        { url: '' },
        { url: 'ftp://10.0.0.2' },
        { url: 'http://' },
        { url: '两台 机器' },
        null,
        { note: '没有地址' },
      ]),
    ).toEqual({ version: PEER_STORE_VERSION, peers: [{ url: 'http://10.0.0.2:9102', note: '办公室' }] });
  });

  it('旧格式（纯地址数组）也能读成 { url, note: "" }', () => {
    expect(normalizePeerStore(['http://10.0.0.2:9102', '192.168.1.5'])).toEqual({
      version: PEER_STORE_VERSION,
      peers: [
        { url: 'http://10.0.0.2:9102', note: '' },
        { url: 'http://192.168.1.5:8787', note: '' },
      ],
    });
  });

  it('备注折叠空白、去首尾并限长', () => {
    const [peer] = store([{ url: 'http://10.0.0.2:9102', note: `  办公室\n 的   Mac ${'x'.repeat(80)}` }]).peers;
    expect(peer?.note.startsWith('办公室 的 Mac')).toBe(true);
    expect(peer?.note).toHaveLength(MAX_PEER_NOTE_LENGTH);
  });

  it('超过上限时截断', () => {
    const raw = Array.from({ length: MAX_PEERS + 3 }, (_, index) => ({ url: `http://10.0.0.${index + 1}:9102` }));
    expect(store(raw).peers).toHaveLength(MAX_PEERS);
  });
});

describe('rememberPeer', () => {
  it('插到最前，并保留这台机器的备注', () => {
    const first = rememberPeer(emptyPeerStore(), 'http://10.0.0.2:9102');
    const noted = setPeerNote(first, '10.0.0.2:9102', '办公室的 Mac');
    const again = rememberPeer(noted, 'http://10.0.0.2:9102/');
    expect(again.peers).toEqual([{ url: 'http://10.0.0.2:9102', note: '办公室的 Mac' }]);

    const second = rememberPeer(again, '192.168.1.5');
    expect(second.peers.map((peer) => peer.url)).toEqual(['http://192.168.1.5:8787', 'http://10.0.0.2:9102']);
  });

  it('非法地址原样返回 store', () => {
    const current = rememberPeer(emptyPeerStore(), 'http://10.0.0.2:9102');
    expect(rememberPeer(current, '  ')).toBe(current);
    expect(rememberPeer(current, 'ftp://10.0.0.2')).toBe(current);
  });

  it('超过上限时丢掉最旧的一条', () => {
    let current = emptyPeerStore();
    for (let index = 0; index < MAX_PEERS + 2; index += 1) {
      current = rememberPeer(current, `http://10.0.1.${index + 1}:9102`);
    }
    expect(current.peers).toHaveLength(MAX_PEERS);
    expect(current.peers[0]?.url).toBe(`http://10.0.1.${MAX_PEERS + 2}:9102`);
  });
});

describe('setPeerNote', () => {
  it('改已存在那条的备注，地址按同机匹配', () => {
    const current = rememberPeer(emptyPeerStore(), 'http://10.0.0.2:9102');
    expect(setPeerNote(current, '10.0.0.2:9102', '办公室').peers[0]?.note).toBe('办公室');
    // 裸地址补的是默认端口，不是「清单里某台机器的端口」
    expect(setPeerNote(current, '10.0.0.2', '办公室')).toBe(current);
  });

  it('地址不在清单里时原样返回', () => {
    const current = rememberPeer(emptyPeerStore(), 'http://10.0.0.2:9102');
    expect(setPeerNote(current, '192.168.1.5', '家里')).toBe(current);
    expect(setPeerNote(current, '', '家里')).toBe(current);
  });
});

describe('findPeer', () => {
  it('按同机匹配，没有就返回 null', () => {
    const current = setPeerNote(rememberPeer(emptyPeerStore(), 'http://10.0.0.2:9102'), '10.0.0.2:9102', '办公室');
    expect(findPeer(current, 'http://10.0.0.2:9102')).toEqual({ url: 'http://10.0.0.2:9102', note: '办公室' });
    expect(findPeer(current, '192.168.1.5')).toBeNull();
    expect(findPeer(current, 'nope')).toBeNull();
  });
});

describe('peerRows', () => {
  const peers = [
    { url: 'http://127.0.0.1:8787' },
    { url: 'http://10.0.0.2:9102', note: '办公室的 Mac' },
    { url: 'http://10.0.0.3:9102' },
  ];

  it('排除当前这台', () => {
    expect(peerRows('http://10.0.0.2:9102', store(peers)).map((peer) => peer.url)).toEqual(['http://10.0.0.3:9102']);
  });

  it('当前不在本机时，本机默认地址不重复出现', () => {
    expect(peerRows('http://10.0.0.9:9102', store(peers)).map((peer) => peer.url)).toEqual([
      'http://10.0.0.2:9102',
      'http://10.0.0.3:9102',
    ]);
  });

  it('当前就在本机时，清单里的本机地址就是当前这台，不重复出现', () => {
    expect(peerRows('http://127.0.0.1:8787', store(peers)).map((peer) => peer.url)).toEqual([
      'http://10.0.0.2:9102',
      'http://10.0.0.3:9102',
    ]);
  });

  it('当前在本机但换了端口时，清单里的默认本机地址仍是一行', () => {
    expect(peerRows('http://127.0.0.1:9101', store(peers)).map((peer) => peer.url)).toEqual([
      'http://127.0.0.1:8787',
      'http://10.0.0.2:9102',
      'http://10.0.0.3:9102',
    ]);
  });

  it('保留备注并按原顺序排列', () => {
    const rows = peerRows('http://10.0.0.9:9102', store(peers));
    expect(rows[0]).toEqual({ url: 'http://10.0.0.2:9102', note: '办公室的 Mac' });
  });
});

// 中转机链接是「别人借给你的入口」，凭据在查询串里：任何一步把它规范化成 origin
// 都会把 t= 抹掉，于是「清单里有这条却打不开」。
describe('relay links', () => {
  const token = '90843bfaa98d07e22ba537d172adccf54d76';
  const link = (session: string) => `https://mica.qirong77.com/?t=${token}&session=${session}`;

  it('keeps the token and session instead of turning it into a bare origin', () => {
    const peers = store([link('s1')]);
    expect(peers.peers[0]?.url).toBe(link('s1'));
  });

  it('同一台机器的不同会话是一条记录，入口跟着最新那条更新', () => {
    let peers = rememberPeer(emptyPeerStore(), link('s1'));
    peers = rememberPeer(peers, link('s2'));
    expect(peers.peers).toHaveLength(1);
    expect(peers.peers[0]?.url).toBe(link('s2'));
  });

  it('不同令牌是不同机器，即使共用一台中转机', () => {
    let peers = rememberPeer(emptyPeerStore(), link('s1'));
    peers = rememberPeer(peers, `https://mica.qirong77.com/?t=another-token-0123456789`);
    expect(peers.peers).toHaveLength(2);
  });

  it('探活带回来的机器名成为默认备注，用户改过就不再覆盖', () => {
    let peers = rememberPeer(emptyPeerStore(), link('s1'), 'Office Mac');
    expect(findPeer(peers, link('s9'))?.note).toBe('Office Mac');
    peers = setPeerNote(peers, link('s1'), '公司的机器');
    peers = rememberPeer(peers, link('s1'), 'Office Mac');
    expect(findPeer(peers, link('s1'))?.note).toBe('公司的机器');
  });

  it('页面由中转机托管时，「当前」能认回清单里那一条', () => {
    // 页面里 location.origin 是不带查询串的，凭它就要匹配上
    const peers = rememberPeer(emptyPeerStore(), link('s1'), 'Office Mac');
    expect(findPeer(peers, 'https://mica.qirong77.com')).not.toBeNull();
    expect(peerRows('https://mica.qirong77.com', peers)).toEqual([]);
  });
});
