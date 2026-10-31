import { useEffect, useMemo, useRef, useState } from 'react';
import { Monitor, Pencil } from 'lucide-react';
import { DEFAULT_RUNTIME_URL, isLoopbackRuntime, relayTokenOf, runtimeLabel } from '@packages/mica-web-shared/index.js';
import { MAX_PEER_NOTE_LENGTH, emptyPeerStore, findPeer, peerRows, rememberPeer, samePeer, setPeerNote } from './peers';
import { createPeerPersistence } from './persistence';

/**
 * 行里显示的地址：中转机链接的 `t=` 是凭据，不能明文摊在侧栏上。
 * 别的部分（尤其 `session`）照旧显示，否则两条链接看起来一模一样。
 */
function displayAddress(url) {
  const text = String(url ?? '');
  return relayTokenOf(text) ? text.replace(/([?&])t=[^&]*/, '$1t=…') : text;
}

/**
 * Connections 的卡片：连接到另一台机器上的 Mica 运行时。
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
  const connecting = useRef(false);
  const savingNote = useRef(false);
  const [error, setError] = useState('');
  // 正在改备注的那条（地址），空串表示没在编辑
  const [noteTarget, setNoteTarget] = useState('');
  const [noteDraft, setNoteDraft] = useState('');
  const persistence = useMemo(() => createPeerPersistence(api), [api]);

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
    void persistence
      .load()
      .then((result) => {
        if (alive) setStore(result);
      })
      .catch((caught) => {
        if (alive) setError(caught?.message || String(caught));
      });
    return () => {
      alive = false;
    };
  }, [persistence]);

  /** 写入成功后更新清单，避免界面把失败的保存显示成成功。 */
  const update = async (updater) => {
    const next = await persistence.update(updater);
    storeRef.current = next;
    setStore(next);
  };
  const save = (updater) => void update(updater).catch((caught) => setError(caught?.message || String(caught)));

  const startNoteEdit = (url) => {
    const note = findPeer(storeRef.current, url)?.note ?? '';
    pendingNote.current = { url, note };
    setNoteTarget(url);
    setNoteDraft(note);
  };
  const saveNote = async () => {
    if (!noteTarget || savingNote.current || pendingNote.current?.url !== noteTarget) return;
    const target = noteTarget;
    const draft = pendingNote.current.note;
    savingNote.current = true;
    try {
      await update((previous) => setPeerNote(previous, target, draft));
      setError('');
      // 保存期间可能已切到另一条备注，或继续修改了草稿。
      if (pendingNote.current?.url === target && pendingNote.current.note === draft) {
        pendingNote.current = null;
        setNoteTarget('');
      }
    } catch (caught) {
      setError(caught?.message || String(caught));
    } finally {
      savingNote.current = false;
    }
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
      if (pending) save((previous) => setPeerNote(previous, pending.url, pending.note));
    },
    // 只在卸载时跑一次：把「正在敲的备注」落盘，重跑会把中途状态当成最终值写回去
    [],
  );

  const connect = async (address) => {
    const target = String(address || '').trim();
    if (!target || connecting.current) return;
    connecting.current = true;
    setError('');
    setBusy(target);
    setNoteTarget('');
    try {
      const result = await api.probe(target);
      if (!result?.ok) {
        setError(result?.error || '连接失败');
        return;
      }
      // 中转机链接：它背后是另一台机器的完整界面（手机用的就是这条）。
      // 桥没连上时页面会是自动重试那一页，先说明原因，仍然打开——桥一起来它就自己恢复。
      if (result.kind === 'relay') {
        if (!result.online) {
          setError(`中转机连着，但 ${result.label} 上的 Mica 没在运行：页面打开后会自己重试。`);
        }
        // 名字取中转机回报的机器名，作为这条记录的默认备注（用户改过就不动）
        await update((previous) => rememberPeer(previous, result.url, result.label));
        api.open(result.url);
        onClose?.();
        return;
      }
      // 对方没开「局域网/公网可访问」时，除了探活指纹之外什么都拿不到：
      // 直接开窗只会得到一个 404 页面。这里说清该去哪台机器上做什么。
      if (result.access === 'off') {
        setError(
          `${result.url} 上的 Mica 没有开启「局域网/公网可访问」：在那台机器上打开侧栏 Connections，打开这个开关并设一个口令，再回来重连。`,
        );
        return;
      }
      // 连回自己这台（比如从别的机器的错误页点回来）不必记进清单：它本来就在侧栏上
      if (!samePeer(result.url, current)) {
        // 探通了才记：地址已经规范成 origin，下次直接从这里点回去
        await update((previous) => rememberPeer(previous, result.url));
        api.open(result.url);
      }
      onClose?.();
    } catch (caught) {
      setError(caught?.message || String(caught));
    } finally {
      connecting.current = false;
      setBusy('');
    }
  };

  const noteInput = (
    <NoteInput
      value={noteDraft}
      onChange={(draft) => {
        pendingNote.current = noteTarget ? { url: noteTarget, note: draft } : null;
        setNoteDraft(draft);
      }}
      onSave={saveNote}
      onCancel={() => {
        pendingNote.current = null;
        setNoteTarget('');
      }}
    />
  );

  return (
    <>
      <h2 className="mb-1 text-sm font-semibold text-fg-max">Connections</h2>
      <p className="mb-2.5 text-[11px] leading-4 text-fg-muted">
        连接到另一台机器上的 Mica 运行时，文件、终端、会话都来自那台机器（在当前窗口之外打开）。
      </p>

      <div className="mb-2.5 rounded-sm border border-line bg-overlay-subtle">
        <div className="group/peer flex items-center gap-2 px-2.5 py-1.5">
          <Monitor size={14} className="shrink-0 text-fg-muted" />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[11px] text-fg-dim">{displayAddress(current)}</span>
            {currentEntry?.note && <span className="block truncate text-[11px] text-fg-soft">{currentEntry.note}</span>}
          </span>
          <span className="shrink-0 text-[10px] text-success-soft">当前</span>
          {currentEntry && <NoteEditButton onClick={() => startNoteEdit(currentEntry.url)} />}
        </div>
        {noteTarget && samePeer(noteTarget, current) && noteInput}
      </div>

      {rows.map((entry) => (
        <div
          key={entry.url}
          className="mb-1.5 rounded-sm border border-line bg-overlay-subtle hover:border-line-strong hover:bg-overlay"
        >
          <div className="group/peer flex items-center gap-2 px-2.5 py-1.5">
            <Monitor size={14} className="shrink-0 text-fg-muted" />
            <button
              type="button"
              disabled={Boolean(busy)}
              className="min-w-0 flex-1 text-left disabled:opacity-60"
              onClick={() => void connect(entry.url)}
            >
              <span className="block truncate text-[11px] text-fg-dim">{displayAddress(entry.url)}</span>
              {entry.note && <span className="block truncate text-[11px] text-fg-soft">{entry.note}</span>}
            </button>
            {busy === entry.url && <span className="shrink-0 text-[10px] text-fg-muted">连接中…</span>}
            <NoteEditButton onClick={() => startNoteEdit(entry.url)} />
          </div>
          {noteTarget === entry.url && noteInput}
        </div>
      ))}

      {showLocal && (
        <button
          type="button"
          disabled={Boolean(busy)}
          className="mb-2 flex h-8 w-full items-center gap-2 rounded-sm border border-dashed border-line bg-overlay-subtle px-2.5 text-left text-xs text-fg-soft hover:border-line-strong hover:text-fg-max disabled:text-fg-ghost"
          onClick={() => void connect(DEFAULT_RUNTIME_URL)}
        >
          <Monitor size={13} className="shrink-0" />
          <span className="shrink-0">本机</span>
          <span className="min-w-0 flex-1 truncate text-[10px] text-fg-dim">{DEFAULT_RUNTIME_URL}</span>
          {busy === DEFAULT_RUNTIME_URL && <span className="text-[10px]">连接中…</span>}
        </button>
      )}

      {error && (
        <div className="mb-2 rounded-sm border border-danger/30 bg-danger/10 px-2.5 py-1.5 text-xs leading-relaxed text-danger">
          {error}
        </div>
      )}

      <div className="flex gap-2">
        <input
          value={value}
          spellCheck={false}
          placeholder="192.168.1.5:8787 或 https://…/?t=…"
          className="h-8 min-w-0 flex-1 rounded-sm border border-line bg-overlay-subtle px-2.5 text-xs text-fg-strong focus:border-line-strong"
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
          className="h-8 shrink-0 rounded-sm bg-overlay-strong px-3.5 text-xs text-fg-strong hover:bg-overlay-heavy disabled:text-fg-ghost"
          onClick={() => void connect(value)}
        >
          连接
        </button>
      </div>
      <RemoteAccess api={api} />
    </>
  );
}

/**
 * 「局域网/公网可访问」：这台运行时要不要口令、口令是什么。
 *
 * 这一节回答的是**别人怎么进来**，和上面「连到别的机器」正好相反，所以单列一段。
 * 值来自运行时的远程访问策略（`api.access`），与请求分派读的是同一份——卡片上看到的
 * 就是别人实际会遇到的。
 */
function RemoteAccess({ api }) {
  const [state, setState] = useState(null);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const writing = useRef(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    let alive = true;
    void api.access
      .get()
      .then((value) => {
        if (!alive) return;
        setState(value);
        setDraft(value?.password ?? '');
      })
      .catch((caught) => {
        if (alive) setError(caught?.message || String(caught));
      });
    return () => {
      alive = false;
    };
  }, [api]);

  // 「已保存」只是确认，不是状态：两秒后自己收起来
  useEffect(() => {
    if (!saved) return undefined;
    const timer = setTimeout(() => setSaved(false), 2000);
    return () => clearTimeout(timer);
  }, [saved]);

  const patch = async (next) => {
    if (writing.current) return;
    writing.current = true;
    const submittedDraft = draft;
    setBusy(true);
    setSaved(false);
    setError('');
    try {
      const written = await api.access.set(next);
      setState((previous) => ({ ...(previous ?? {}), ...written }));
      setDraft((previous) => (previous === submittedDraft ? (written?.password ?? '') : previous));
      setSaved(true);
    } catch (caught) {
      setError(caught?.message || String(caught));
    } finally {
      writing.current = false;
      setBusy(false);
    }
  };

  const enabled = state?.enabled === true;
  const password = state?.password ?? '';
  const address = state?.addresses?.[0] ?? '';
  const savePassword = () => {
    const next = draft.trim();
    if (!next || next === password) return;
    void patch({ password: next });
  };

  return (
    <div className="mt-3 border-t border-line pt-2.5">
      <div className="mb-1 flex items-center gap-2">
        <span className="min-w-0 flex-1 text-[11px] text-fg-soft">局域网/公网可访问</span>
        {saved && <span className="shrink-0 text-[10px] text-success-soft">已保存</span>}
        <button
          type="button"
          role="switch"
          aria-checked={enabled}
          aria-label="局域网/公网可访问"
          disabled={!state || busy}
          className={`relative h-4 w-7 shrink-0 rounded-full transition-colors disabled:opacity-50 ${
            enabled ? 'bg-success/70' : 'bg-overlay-heavy'
          }`}
          onClick={() => void patch({ enabled: !enabled })}
        >
          <span
            className={`absolute top-0.5 h-3 w-3 rounded-full bg-white transition-all ${
              enabled ? 'left-3.5' : 'left-0.5'
            }`}
          />
        </button>
      </div>
      {enabled && (
        <div className="mt-1.5 flex items-center gap-2">
          <input
            value={draft}
            spellCheck={false}
            maxLength={64}
            aria-label="访问口令"
            placeholder="访问口令"
            className="h-7 min-w-0 flex-1 rounded-sm border border-line bg-overlay-subtle px-2 font-mono text-[11px] tracking-wider text-fg-strong placeholder:text-fg-faint focus:border-line-strong"
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
                event.preventDefault();
                savePassword();
              }
            }}
            onBlur={savePassword}
          />
          <span className="shrink-0 text-[10px] text-fg-dim">回车保存</span>
        </div>
      )}

      {enabled && address && (
        <p className="mt-1.5 text-[10px] leading-4 text-fg-dim">
          别人打开 <span className="text-fg-muted">{address}</span> 时输入这个口令
          {password === '0000' && <span className="text-warn-soft">（默认 0000，建议改掉）</span>}
        </p>
      )}

      {!state && !error && <p className="text-[10px] text-fg-faint">读取中…</p>}
      {error && (
        <p className="mt-1 rounded-sm border border-danger/30 bg-danger/10 px-2 py-1 text-[10px] leading-4 text-danger">
          {error}
        </p>
      )}
    </div>
  );
}

/** 行尾的铅笔：鼠标移到这一行才浮出来（触屏没有悬停，常显） */
function NoteEditButton({ onClick }) {
  return (
    <button
      type="button"
      title="备注"
      aria-label="备注"
      className="shrink-0 rounded-sm p-0.5 text-fg-dim opacity-0 transition-opacity hover:bg-overlay-strong hover:text-fg-max group-hover/peer:opacity-100 max-md:opacity-100"
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
        className="h-7 min-w-0 flex-1 rounded-sm border border-line bg-overlay-subtle px-2 text-[11px] text-fg-strong placeholder:text-fg-faint focus:border-line-strong"
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={onKeyDown}
        onBlur={onBlur}
      />
      <span className="shrink-0 text-[10px] text-fg-dim">回车保存</span>
    </div>
  );
}
