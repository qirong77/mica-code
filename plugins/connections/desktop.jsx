import { useEffect, useRef, useState } from 'react';
import { Monitor, Pencil } from 'lucide-react';
import {
  DEFAULT_RUNTIME_URL,
  isLoopbackRuntime,
  isSameRuntime,
  runtimeLabel,
} from '@packages/mica-web-shared/index.js';
import {
  MAX_PEER_NOTE_LENGTH,
  emptyPeerStore,
  findPeer,
  normalizePeerStore,
  peerRows,
  rememberPeer,
  setPeerNote,
} from './peers';

/**
 * 「连接」的卡片：连接到另一台机器上的 Mica 运行时。
 *
 * 页面由哪台运行时托管就代表在用哪台，所以「切过去」= 打开那个地址：外壳里弹一个新
 * 窗口，浏览器里开新标签页。连过的地址记在插件自己的数据文件里（`plugin-data/connections`），
 * 于是这台机器上的任何窗口都能点回去，不必再抄一遍 IP；记不住 IP 的话每条可以起个备注。
 *
 * 宿主只提供三样东西（见 `api`）：探活、打开地址、读写这份数据。探活必须由运行时代劳
 * ——页面跨源 `fetch` 读不到结果。
 */

/** 入口行右侧那一行状态：此刻在哪台运行时上。 */
export function summary(api) {
  return runtimeLabel(api?.currentHost?.());
}

export default function ConnectionsCard({ api, onClose }) {
  const [store, setStore] = useState(emptyPeerStore);
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  // 正在改备注的那条（地址），空串表示没在编辑
  const [noteTarget, setNoteTarget] = useState('');
  const [noteDraft, setNoteDraft] = useState('');

  const current = api.currentHost();
  // 已经在回环地址上就说明人就在这台机器上，「本机」这个回程入口没有意义（页面可能跑在
  // 非默认端口上，那时回环默认地址甚至不是当前这台）
  const showLocal = !isLoopbackRuntime(current);
  const rows = peerRows(current, store);
  const currentEntry = findPeer(store, current);

  const storeRef = useRef(store);
  useEffect(() => {
    storeRef.current = store;
  }, [store]);

  useEffect(() => {
    let alive = true;
    void api
      .readData()
      .then((result) => {
        if (alive) setStore(normalizePeerStore(result?.value));
      })
      .catch(() => {
        // 读不出来就当还没连过：下次连接成功会整份写回去
      });
    return () => {
      alive = false;
    };
  }, [api]);

  /** 改清单：落盘跟着状态更新走，不另开一条写入路径 */
  const update = (updater) => {
    const next = updater(storeRef.current);
    if (next === storeRef.current) return;
    storeRef.current = next;
    setStore(next);
    void api.writeData(next);
  };

  const startNoteEdit = (url) => {
    setNoteTarget(url);
    setNoteDraft(findPeer(storeRef.current, url)?.note ?? '');
  };
  const saveNote = () => {
    if (!noteTarget) return;
    const target = noteTarget;
    const draft = noteDraft;
    setNoteTarget('');
    update((previous) => setPeerNote(previous, target, draft));
  };

  // 卡片是悬停浮层，鼠标滑出去就收起来了：正在敲的备注在卸载时直接落盘，
  // 免得「滑出去一下就白打」。Esc 取消已经把 noteTarget 清空，这里自然不会写。
  const pendingNote = useRef(null);
  useEffect(() => {
    pendingNote.current = noteTarget ? { url: noteTarget, note: noteDraft } : null;
  }, [noteTarget, noteDraft]);
  useEffect(
    () => () => {
      const pending = pendingNote.current;
      if (pending) update((previous) => setPeerNote(previous, pending.url, pending.note));
    },
    // 只在卸载时跑一次：把「正在敲的备注」落盘，重跑会把中途状态当成最终值写回去
    [],
  );

  const connect = async (address) => {
    const target = String(address || '').trim();
    if (!target || busy) return;
    setError('');
    setBusy(target);
    setNoteTarget('');
    try {
      const result = await api.probe(target);
      if (!result?.ok) {
        setError(result?.error || '连接失败');
        return;
      }
      // 连回自己这台（比如从别的机器的错误页点回来）不必记进清单：它本来就在侧栏上
      if (!isSameRuntime(result.url, current)) {
        // 探通了才记：地址已经规范成 origin，下次直接从这里点回去
        update((previous) => rememberPeer(previous, result.url));
        api.open(result.url);
      }
      onClose?.();
    } catch (caught) {
      setError(caught?.message || String(caught));
    } finally {
      setBusy('');
    }
  };

  const noteInput = (
    <NoteInput value={noteDraft} onChange={setNoteDraft} onSave={saveNote} onCancel={() => setNoteTarget('')} />
  );

  return (
    <>
      <h2 className="mb-1 text-sm font-semibold text-white/95">连接</h2>
      <p className="mb-2.5 text-[11px] leading-4 text-white/40">
        连接到另一台机器上的 Mica 运行时，文件、终端、会话都来自那台机器（在当前窗口之外打开）。
      </p>

      <div className="mb-2.5 rounded-sm border border-line bg-white/[.03]">
        <div className="group/peer flex items-center gap-2 px-2.5 py-1.5">
          <Monitor size={14} className="shrink-0 text-white/45" />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[11px] text-white/35">{current}</span>
            {currentEntry?.note && (
              <span className="block truncate text-[11px] text-white/60">{currentEntry.note}</span>
            )}
          </span>
          <span className="shrink-0 text-[10px] text-green-400/70">当前</span>
          {currentEntry && <NoteEditButton onClick={() => startNoteEdit(currentEntry.url)} />}
        </div>
        {noteTarget && isSameRuntime(noteTarget, current) && noteInput}
      </div>

      {rows.map((entry) => (
        <div
          key={entry.url}
          className="mb-1.5 rounded-sm border border-line bg-white/[.03] hover:border-white/25 hover:bg-white/[.07]"
        >
          <div className="group/peer flex items-center gap-2 px-2.5 py-1.5">
            <Monitor size={14} className="shrink-0 text-white/45" />
            <button
              type="button"
              disabled={Boolean(busy)}
              className="min-w-0 flex-1 text-left disabled:opacity-60"
              onClick={() => void connect(entry.url)}
            >
              <span className="block truncate text-[11px] text-white/35">{entry.url}</span>
              {entry.note && <span className="block truncate text-[11px] text-white/60">{entry.note}</span>}
            </button>
            {busy === entry.url && <span className="shrink-0 text-[10px] text-white/40">连接中…</span>}
            <NoteEditButton onClick={() => startNoteEdit(entry.url)} />
          </div>
          {noteTarget === entry.url && noteInput}
        </div>
      ))}

      {showLocal && (
        <button
          type="button"
          disabled={Boolean(busy)}
          className="mb-2 flex h-8 w-full items-center gap-2 rounded-sm border border-dashed border-white/15 bg-white/[.02] px-2.5 text-left text-xs text-white/60 hover:border-white/35 hover:text-white disabled:text-white/25"
          onClick={() => void connect(DEFAULT_RUNTIME_URL)}
        >
          <Monitor size={13} className="shrink-0" />
          <span className="shrink-0">本机</span>
          <span className="min-w-0 flex-1 truncate text-[10px] text-white/30">{DEFAULT_RUNTIME_URL}</span>
          {busy === DEFAULT_RUNTIME_URL && <span className="text-[10px]">连接中…</span>}
        </button>
      )}

      {error && (
        <div className="mb-2 rounded-sm border border-red-500/30 bg-red-500/10 px-2.5 py-1.5 text-xs leading-relaxed text-red-300">
          {error}
        </div>
      )}

      <div className="flex gap-2">
        <input
          value={value}
          spellCheck={false}
          placeholder="另一台机器的地址，如 192.168.1.5:8787"
          className="h-8 min-w-0 flex-1 rounded-sm border border-white/15 bg-white/[.04] px-2.5 text-xs text-white focus:border-white/30"
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
              event.preventDefault();
              void connect(value);
            }
          }}
        />
        <button
          type="button"
          disabled={!value.trim() || Boolean(busy)}
          className="h-8 shrink-0 rounded-sm bg-white/10 px-3.5 text-xs text-white/85 hover:bg-white/15 disabled:text-white/25"
          onClick={() => void connect(value)}
        >
          连接
        </button>
      </div>
      <p className="mt-2 text-[10px] leading-4 text-white/30">桌面应用内可用 ⇧⌘M 回到本机窗口。</p>
    </>
  );
}

/** 行尾的铅笔：鼠标移到这一行才浮出来（触屏没有悬停，常显） */
function NoteEditButton({ onClick }) {
  return (
    <button
      type="button"
      title="备注"
      aria-label="备注"
      className="shrink-0 rounded-sm p-0.5 text-white/35 opacity-0 transition-opacity hover:bg-white/10 hover:text-white group-hover/peer:opacity-100 max-md:opacity-100"
      onClick={onClick}
    >
      <Pencil size={12} />
    </button>
  );
}

/**
 * 备注的就地编辑器：回车或失焦保存、Esc 取消（Esc 不能冒泡出去，否则整张卡片会跟着关掉）。
 */
function NoteInput({ value, onChange, onSave, onCancel }) {
  const cancelled = useRef(false);
  const onKeyDown = (event) => {
    if (event.key === 'Escape') {
      event.stopPropagation();
      cancelled.current = true;
      onCancel();
      return;
    }
    if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
      event.preventDefault();
      onSave();
    }
  };
  const onBlur = () => {
    if (cancelled.current) {
      cancelled.current = false;
      return;
    }
    onSave();
  };

  return (
    <div className="flex items-center gap-2 border-t border-line px-2.5 py-1.5">
      <input
        autoFocus
        value={value}
        maxLength={MAX_PEER_NOTE_LENGTH}
        spellCheck={false}
        placeholder="备注，如「办公室的 Mac」"
        className="h-7 min-w-0 flex-1 rounded-sm border border-white/15 bg-white/[.04] px-2 text-[11px] text-white placeholder:text-white/25 focus:border-white/30"
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={onKeyDown}
        onBlur={onBlur}
      />
      <span className="shrink-0 text-[10px] text-white/30">回车保存</span>
    </div>
  );
}
