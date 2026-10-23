import { useCallback, useEffect, useState } from 'react';
import { PageFrame } from '../components/PageFrame.js';
import { Alert, Button } from '../components/Ui.js';
import { AutoCompactFields } from '../components/AutoCompactFields.js';
import { confirmDialog } from '../components/DialogHost.js';
import {
  autoCompactCounterTitle,
  autoCompactDraftFromSettings,
  autoCompactKindLabel,
  autoCompactNumbersFromSettings,
  autoCompactRunLabel,
  autoCompactSettingsFromDraft,
  autoCompactStatusLabel,
  formatAutoCompactTime,
  type AutoCompactDraft,
} from '../autoCompact.js';
import { readAutoCompactDetails, resetAutoCompactCounters, writeAutoCompactSettings } from '../api.js';
import type { ConfigWebAutoCompactCounter, ConfigWebAutoCompactDetails } from '../../src/shared/types.js';
import { appIcons } from '../icons.js';

/**
 * Auto Compact：一次模型请求跑完就检查 ctx，超过阈值就压缩，不等整个任务结束。
 *
 * 设置与按会话记账的计数都属于**这台机器上的运行时**（桌面端落在它的 userData 目录里，
 * 磁盘上的哪一份由 `details.path` 说了算），所以这一节只在提供这份数据的宿主里出现
 * （见 `api.ts` 的 `supportsAutoCompact`）。表单的换算与校验在 `autoCompact.ts`。
 */
export function AutoCompactPage() {
  const [details, setDetails] = useState<ConfigWebAutoCompactDetails | null>(null);
  const [draft, setDraft] = useState<AutoCompactDraft | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [resetting, setResetting] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const RefreshIcon = appIcons.refresh;
  const SaveIcon = appIcons.save;
  const TrashIcon = appIcons.trash;

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const payload = await readAutoCompactDetails();
      setDetails(payload);
      setDraft(autoCompactDraftFromSettings(payload.settings));
    } catch (loadError) {
      setError(formatError(loadError));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function save() {
    if (!draft) return;
    const parsed = autoCompactSettingsFromDraft(draft);
    if (!parsed.ok) {
      setError(parsed.error);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const payload = await writeAutoCompactSettings(parsed.settings);
      setDetails(payload);
      setDraft(autoCompactDraftFromSettings(payload.settings));
      setSaved(true);
      window.setTimeout(() => setSaved(false), 1600);
    } catch (saveError) {
      setError(formatError(saveError));
    } finally {
      setSaving(false);
    }
  }

  async function reset(sessionId?: string) {
    const target = sessionId ?? '';
    const confirmed = await confirmDialog({
      title: '重置压缩计数',
      message: sessionId
        ? `确认清掉这个会话的压缩次数？清掉只是账本归零，已压缩的上下文不受影响。`
        : '确认清掉所有会话的压缩次数？清掉只是账本归零，已压缩的上下文不受影响。',
      confirmText: '重置',
      danger: true,
    });
    if (!confirmed) return;
    setResetting(target || 'all');
    setError(null);
    try {
      const payload = await resetAutoCompactCounters(sessionId);
      setDetails(payload);
      setDraft((current) => current ?? autoCompactDraftFromSettings(payload.settings));
    } catch (resetError) {
      setError(formatError(resetError));
    } finally {
      setResetting(null);
    }
  }

  const setField = <K extends keyof AutoCompactDraft>(key: K, value: AutoCompactDraft[K]) => {
    setDraft((current) => (current ? { ...current, [key]: value } : current));
    setError(null);
  };

  const dirty =
    details && draft ? JSON.stringify(draft) !== JSON.stringify(autoCompactDraftFromSettings(details.settings)) : false;

  return (
    <PageFrame
      title="Auto Compact"
      path={details?.path}
      actions={
        <div className="toolbar">
          {saved ? <span className="save-status">已保存</span> : null}
          <Button icon={<RefreshIcon size={15} />} title="重新加载" onClick={() => void load()} loading={loading} />
          <Button
            variant="primary"
            icon={<SaveIcon size={15} />}
            onClick={() => void save()}
            loading={saving}
            disabled={loading || !draft || !dirty}
          >
            保存
          </Button>
        </div>
      }
    >
      <div className="detail-body detail-body-stacked">
        {error ? <Alert message={error} /> : null}
        {loading && !details ? (
          <div className="page-loading">正在加载 Auto Compact…</div>
        ) : !details || !draft ? null : (
          <div className="auto-compact-stack">
            <section className="simple-card auto-compact-card">
              <header className="auto-compact-card-head">
                <div className="auto-compact-head-copy">
                  <h2>规则</h2>
                  <p>{autoCompactStatusLabel(details)}</p>
                </div>
              </header>

              {/* 与会话弹窗同一个组件：字段表、步进、单位只在这里定义一次 */}
              <AutoCompactFields
                draft={draft}
                defaults={autoCompactNumbersFromSettings(details.defaults)}
                onChange={(key, value) => setField(key, value)}
                onToggle={(enabled) => setField('enabled', enabled)}
              />

              <div className="auto-compact-footer">
                <ul className="auto-compact-rules">
                  <li>快速压缩是本地清理（不调用模型），总是先跑；清完仍高于模型阈值才升级为模型压缩（LLM 摘要）。</li>
                  <li>次数用尽后不再压缩，0 表示不做这一类。</li>
                  <li>
                    两次压缩至少间隔「压缩间隔」的分钟数（升级算同一次），0 表示不限制；阈值另有安全下限（快速
                    150k、模型 100k）。
                  </li>
                </ul>
                <Button
                  onClick={() => setDraft(autoCompactDraftFromSettings(details.defaults))}
                  disabled={loading || saving}
                >
                  恢复默认
                </Button>
              </div>
            </section>

            <section className="simple-card auto-compact-card">
              <header className="auto-compact-card-head">
                <div className="auto-compact-head-copy">
                  <h2>运行计数</h2>
                  <p>按会话记的压缩次数与省下的 token</p>
                </div>
                {details.counters.length > 0 ? (
                  <Button
                    icon={<TrashIcon size={14} />}
                    title="把所有会话的计数清零（不影响设置）"
                    disabled={resetting !== null}
                    loading={resetting === 'all'}
                    onClick={() => void reset()}
                  >
                    全部重置
                  </Button>
                ) : null}
              </header>

              {details.counters.length === 0 ? (
                <p className="auto-compact-note">还没有会话触发过自动压缩。</p>
              ) : (
                <div className="auto-compact-counter-list">
                  {details.counters.map((counter) => (
                    <CounterRow
                      key={counter.sessionId}
                      counter={counter}
                      settings={details.settings}
                      resetting={resetting === counter.sessionId}
                      disabled={resetting !== null}
                      onReset={() => void reset(counter.sessionId)}
                    />
                  ))}
                </div>
              )}
            </section>
          </div>
        )}
      </div>
    </PageFrame>
  );
}

function CounterRow({
  counter,
  settings,
  resetting,
  disabled,
  onReset,
}: {
  counter: ConfigWebAutoCompactCounter;
  settings: ConfigWebAutoCompactDetails['settings'];
  resetting: boolean;
  disabled: boolean;
  onReset(): void;
}) {
  const TrashIcon = appIcons.trash;
  const kind = autoCompactKindLabel(counter.lastKind);
  const lastRun = counter.lastRunAt
    ? `最近 ${formatAutoCompactTime(counter.lastRunAt)}${kind ? ` · ${kind}` : ''}${
        counter.lastSavedTokens > 0 ? ` · 省下 ${counter.lastSavedTokens} tokens` : ''
      }`
    : '还没有压缩成功过';
  return (
    <div className="auto-compact-counter-row">
      <div className="auto-compact-counter-copy">
        <strong title={counter.title || counter.sessionId}>{autoCompactCounterTitle(counter)}</strong>
        <span className="auto-compact-counter-meta" title={lastRun}>
          {autoCompactRunLabel(counter, settings)} · {lastRun}
        </span>
      </div>
      <Button
        icon={<TrashIcon size={14} />}
        title="重置这个会话的计数"
        disabled={disabled}
        loading={resetting}
        onClick={onReset}
      >
        重置
      </Button>
    </div>
  );
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
