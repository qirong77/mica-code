import { useCallback, useEffect, useMemo, useState } from 'react';
import { Check, Pencil, Plus, Tags, Trash2 } from 'lucide-react';
import { Alert, Button, Empty } from '@mica-config-ui/web';
import {
  DEFAULT_TAG_COLOR,
  MAX_TAGS,
  TAG_PALETTE,
  addTag,
  cleanTagLabel,
  recolorTag,
  removeTag,
  renameTag,
} from './model.js';

/**
 * 标签整页：定义有哪些标签（名字 + 颜色）。
 *
 * 打标不在这里做——那是会话行右键菜单的事（宿主按这份色板画菜单项），这个页面只维护
 * 色板本身。所以它是一页「清单 + 增删改」，没有会话、没有选中状态。
 *
 * 页面自己不做落盘：`session-annotations.json` 的 `options` 由运行时代写
 * （`api.annotations`，见 `apps/desktop/src/host/session-annotations.js`），因为页面没有
 * 文件系统、而这份文件还要和插件命令、右键菜单共用同一把跨进程锁。
 *
 * 校验（空名字、重名、上限）来自 `model.ts`，与后端同一条：命令与页面不能各有一套规则。
 */

function errorText(error) {
  return error instanceof Error ? error.message : String(error);
}

/** 页面上只编辑标签表，归属留空——计数由宿主返回，那才是真实的会话数。 */
function localStore(options) {
  return { version: 1, name: 'Session Tags', options, assignments: {} };
}

export default function TagsPage({ api }) {
  const [options, setOptions] = useState([]);
  const [counts, setCounts] = useState({});
  const [status, setStatus] = useState('loading');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [draftLabel, setDraftLabel] = useState('');
  const [draftColor, setDraftColor] = useState(DEFAULT_TAG_COLOR);
  // 正在改的那一行（id 为 null 表示没在改）
  const [editing, setEditing] = useState(null);
  // 待确认删除的标签：删一个标签会把它从所有会话上摘掉，先问一句
  const [confirming, setConfirming] = useState('');

  const store = useMemo(() => localStore(options), [options]);
  const supported = Boolean(api?.annotations);

  const load = useCallback(async () => {
    if (!supported) {
      setStatus('unsupported');
      return;
    }
    setStatus('loading');
    setError('');
    try {
      const result = await api.annotations.read();
      if (!result?.ok) throw new Error(result?.error || '读取标签失败');
      setOptions(Array.isArray(result.options) ? result.options : []);
      setCounts(result.counts || {});
      setStatus('ready');
    } catch (caught) {
      setError(errorText(caught));
      setStatus('error');
    }
  }, [api, supported]);

  useEffect(() => {
    void load();
  }, [load]);

  /** 整份写回：成功就把宿主归一化后的结果作为最新的表（它可能顺手改了非法颜色）。 */
  const write = useCallback(
    async (next) => {
      setBusy(true);
      setError('');
      try {
        const result = await api.annotations.writeOptions(next.options);
        if (!result?.ok) throw new Error(result?.error || '保存失败');
        setOptions(Array.isArray(result.options) ? result.options : []);
        setCounts(result.counts || {});
        return true;
      } catch (caught) {
        setError(errorText(caught));
        return false;
      } finally {
        setBusy(false);
      }
    },
    [api],
  );

  const submitDraft = async () => {
    const added = addTag(store, { label: draftLabel, color: draftColor });
    if (added.error) {
      setError(added.error);
      return;
    }
    if (await write(added.store)) {
      setDraftLabel('');
      setDraftColor(DEFAULT_TAG_COLOR);
    }
  };

  const submitEdit = async () => {
    if (!editing) return;
    const renamed = renameTag(store, editing.id, editing.label);
    if (renamed.error) {
      setError(renamed.error);
      return;
    }
    const recolored = recolorTag(renamed.store, editing.id, editing.color);
    if (recolored.error) {
      setError(recolored.error);
      return;
    }
    if (await write(recolored.store)) setEditing(null);
  };

  const confirmRemove = async (id) => {
    const result = removeTag(store, id);
    if (result.error) {
      setError(result.error);
      return;
    }
    setConfirming('');
    if (!(await write(result.store))) return;
    if (editing?.id === id) setEditing(null);
  };

  return (
    <div className="flex h-full min-h-0 flex-col bg-canvas">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 border-b border-line px-4 py-3">
        <span className="text-sm font-medium text-fg-strong">标签</span>
        <span className="text-xs text-fg-muted">
          在会话行上右键就能打标。改名字、换颜色不会影响已经打过的会话。
        </span>
      </div>

      <div className="min-h-0 flex-1 overflow-auto">
        {status === 'loading' && <div className="px-4 py-6 text-xs text-fg-muted">正在读取…</div>}

        {status === 'unsupported' && (
          <div className="px-4 py-6 text-xs text-fg-muted">
            当前宿主还不支持在页面里维护标签，升级后再试。
          </div>
        )}

        {status === 'error' && !options.length && (
          <div className="px-4 py-4">
            <Alert message={error} />
            <div className="mt-2">
              <Button size="compact" onClick={() => void load()}>
                重试
              </Button>
            </div>
          </div>
        )}

        {status === 'ready' && options.length === 0 && (
          <div className="grid h-full place-items-center px-6 py-10">
            <Empty
              title="还没有标签"
              description="在下面输入一个名字、挑个颜色，就多一个能打在会话上的标签。"
            />
          </div>
        )}

        {options.length > 0 && (
          <ul className="divide-y divide-line-soft">
            {options.map((option) =>
              editing?.id === option.id ? (
                <li key={option.id} className="flex flex-wrap items-center gap-2 bg-panel px-4 py-2.5">
                  <input
                    className="text-input is-compact w-56"
                    value={editing.label}
                    autoFocus
                    maxLength={24}
                    aria-label="标签名"
                    onChange={(event) => setEditing({ ...editing, label: event.target.value })}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') void submitEdit();
                      if (event.key === 'Escape') setEditing(null);
                    }}
                  />
                  <Palette
                    value={editing.color}
                    onChange={(color) => setEditing({ ...editing, color })}
                    disabled={busy}
                  />
                  <div className="ml-auto flex items-center gap-1">
                    <Button variant="accent" size="compact" disabled={busy} onClick={() => void submitEdit()}>
                      保存
                    </Button>
                    <Button variant="ghost" size="compact" onClick={() => setEditing(null)}>
                      取消
                    </Button>
                  </div>
                </li>
              ) : (
                <li key={option.id} className="flex items-center gap-3 px-4 py-2.5">
                  <span
                    className="h-2.5 w-2.5 shrink-0 rounded-full"
                    style={{ backgroundColor: option.color }}
                    aria-hidden="true"
                  />
                  <span className="min-w-0 flex-1 truncate text-sm text-fg-strong">{option.label}</span>
                  <span className="shrink-0 text-xs tabular-nums text-fg-muted">
                    {counts[option.id] || 0} 个会话
                  </span>
                  {confirming === option.id ? (
                    <div className="flex shrink-0 items-center gap-1">
                      <Button
                        variant="danger"
                        size="compact"
                        disabled={busy}
                        onClick={() => void confirmRemove(option.id)}
                      >
                        确认删除
                      </Button>
                      <Button variant="ghost" size="compact" onClick={() => setConfirming('')}>
                        取消
                      </Button>
                    </div>
                  ) : (
                    <div className="flex shrink-0 items-center gap-1">
                      <Button
                        variant="ghost"
                        size="compact"
                        icon={<Pencil size={12} />}
                        title="改名 / 换颜色"
                        onClick={() => {
                          setError('');
                          setEditing({ id: option.id, label: option.label, color: option.color });
                        }}
                      />
                      <Button
                        variant="danger-ghost"
                        size="compact"
                        icon={<Trash2 size={12} />}
                        title="删除标签"
                        onClick={() => {
                          setError('');
                          setConfirming(option.id);
                        }}
                      />
                    </div>
                  )}
                </li>
              ),
            )}
          </ul>
        )}
      </div>

      <div className="border-t border-line bg-panel px-4 py-3">
        <div className="flex flex-wrap items-center gap-2">
          <input
            className="text-input is-compact w-56"
            placeholder="新标签，例如 待 review"
            value={draftLabel}
            maxLength={24}
            aria-label="新标签名字"
            disabled={!supported || busy}
            onChange={(event) => {
              setError('');
              setDraftLabel(event.target.value);
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter') void submitDraft();
            }}
          />
          <Palette value={draftColor} onChange={setDraftColor} disabled={!supported || busy} />
          <Button
            variant="accent"
            size="compact"
            icon={<Plus size={12} />}
            loading={busy}
            disabled={!supported || !cleanTagLabel(draftLabel)}
            onClick={() => void submitDraft()}
          >
            添加
          </Button>
          <span className="ml-auto flex items-center gap-1 text-xs text-fg-muted">
            <Tags size={12} />
            {options.length} / {MAX_TAGS}
          </span>
        </div>
        {error && status !== 'error' && (
          <div className="mt-2">
            <Alert message={error} />
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * 颜色选择：一排固定色板。
 *
 * 不做自由取色——深色侧栏上的对比度没法保证，而标签色点是用来「一眼认出」的，不是一个
 * 设计工具。选中态用一枚勾而不是描边：描边在深色背景上容易被当成另一层阴影。
 */
function Palette({ value, onChange, disabled = false }) {
  return (
    <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="标签颜色">
      {TAG_PALETTE.map((color) => {
        const selected = value === color;
        return (
          <button
            key={color}
            type="button"
            title={color}
            aria-label={color}
            aria-pressed={selected}
            disabled={disabled}
            className="flex h-5 w-5 items-center justify-center rounded-full transition-transform hover:scale-110 disabled:opacity-50"
            style={{ backgroundColor: color, boxShadow: 'inset 0 0 0 1px rgb(0 0 0 / 0.18)' }}
            onClick={() => onChange(color)}
          >
            {selected && <Check size={12} strokeWidth={3} className="text-white drop-shadow" />}
          </button>
        );
      })}
    </div>
  );
}
