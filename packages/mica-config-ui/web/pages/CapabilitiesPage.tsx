import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { PageFrame } from '../components/PageFrame.js';
import { Alert, Button } from '../components/Ui.js';
import { CapabilityList, CapabilityParameters } from '../components/CapabilityList.js';
import { applyGroupEnabled } from '../capabilityGroups.js';
import { Modal } from '../components/Modal.js';
import { readCapabilityDefaults, writeCapabilityDefaults } from '../api.js';
import { appIcons } from '../icons.js';
import type { ConfigWebCapabilityDefaults } from '../../src/shared/types.js';

type Group = 'skills' | 'tools' | 'mcpServers';

type Draft = {
  disabledSkills: string[];
  disabledTools: string[];
  disabledMcpServers: string[];
};

type Item = {
  name: string;
  description: string;
  /** 所属工具分组；技能与 MCP 服务器没有。 */
  group?: { key: string; label: string } | null;
  /** 工具是否只读；skills / MCP server 没有这一项。 */
  readOnly?: boolean;
  parameters?: Array<{ name: string; type: string; required: boolean; description: string }>;
};

const GROUP_LABEL: Record<Group, string> = {
  tools: 'Tools',
  skills: 'Skills',
  mcpServers: 'MCP servers',
};

/** 页签顺序：工具最常用，MCP 最少调整。 */
const GROUPS: Group[] = ['tools', 'skills', 'mcpServers'];

const EMPTY_DRAFT: Draft = { disabledSkills: [], disabledTools: [], disabledMcpServers: [] };

/**
 * 新会话默认能力。只写入 config.json 的 `capabilityDefaults`，所以改这里不会动到已经在
 * 会话里单独调整过开关的对话。会话内的开关在 `/capabilities`（CLI）或输入框旁的能力面板
 * （桌面端）。
 *
 * 与其他设置页不同，这里没有「保存」按钮：拨一下就直接落盘。写盘串行化，连点时攒成
 * 「最后一次选择」再发一轮请求，不丢点击也不让两个请求互相覆盖。
 */
export function CapabilitiesPage() {
  const [details, setDetails] = useState<ConfigWebCapabilityDefaults | null>(null);
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  const [group, setGroup] = useState<Group>('tools');
  const [detail, setDetail] = useState<Item | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<SaveStatus>(null);
  // 保存标志的同步副本：连着拨两下时要立刻判重，不能等 setState 触发重渲染。
  const savingRef = useRef(false);
  // 本地最新选择（不依赖尚未重渲染的 state）、服务端已确认的选择、待发的下一轮请求。
  const draftRef = useRef<Draft>(EMPTY_DRAFT);
  const confirmedRef = useRef<Draft>(EMPTY_DRAFT);
  const pendingSaveRef = useRef<Draft | null>(null);
  const savedTimerRef = useRef<number | null>(null);
  const RefreshIcon = appIcons.refresh;

  const applyDetails = useCallback((next: ConfigWebCapabilityDefaults) => {
    const applied = toDraft(next);
    setDetails(next);
    draftRef.current = applied;
    confirmedRef.current = applied;
    setDraft(applied);
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      applyDetails(await readCapabilityDefaults());
      setStatus(null);
    } catch (loadError) {
      setError(formatError(loadError));
    } finally {
      setLoading(false);
    }
  }, [applyDetails]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => () => clearSavedTimer(savedTimerRef), []);

  const flushSave = useCallback(async () => {
    if (savingRef.current) return;
    const next = pendingSaveRef.current;
    if (!next) return;
    pendingSaveRef.current = null;
    savingRef.current = true;
    clearSavedTimer(savedTimerRef);
    setStatus('saving');
    setError(null);
    try {
      const saved = await writeCapabilityDefaults(next);
      const applied = toDraft(saved);
      confirmedRef.current = applied;
      setDetails(saved);
      // 请求期间又拨了几下时本地已有更新的选择，不用这次的响应盖回去。
      if (!pendingSaveRef.current) {
        draftRef.current = applied;
        setDraft(applied);
        setStatus('saved');
        savedTimerRef.current = window.setTimeout(() => {
          savedTimerRef.current = null;
          setStatus((current) => (current === 'saved' ? null : current));
        }, 1600);
      }
    } catch (saveError) {
      pendingSaveRef.current = null;
      const confirmed = confirmedRef.current;
      draftRef.current = confirmed;
      setDraft(confirmed);
      setStatus(null);
      setError(formatError(saveError));
    } finally {
      savingRef.current = false;
      if (pendingSaveRef.current) void flushSave();
    }
  }, []);

  const commit = useCallback(
    (next: Draft) => {
      draftRef.current = next;
      setDraft(next);
      pendingSaveRef.current = next;
      void flushSave();
    },
    [flushSave],
  );

  const items = useMemo(() => {
    if (!details) return [];
    if (group === 'skills')
      return details.skills.map((skill) => ({ name: skill.name, description: skill.description }));
    if (group === 'tools')
      return details.tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        group: tool.group,
        readOnly: tool.readOnly,
        parameters: tool.parameters,
      }));
    return details.mcpServers.map((name) => ({ name, description: '' }));
  }, [details, group]);

  const disabled = draft[disabledKey(group)];
  const enabledCount = items.filter((item) => !disabled.includes(item.name)).length;

  function toggle(name: string, enabled: boolean) {
    const key = disabledKey(group);
    const next = new Set(draftRef.current[key]);
    if (enabled) next.delete(name);
    else next.add(name);
    commit({ ...draftRef.current, [key]: [...next] });
  }

  // 整组开关：一次改写组内全部成员，落到同一个禁用名单里（能力校验按工具名逐条判定）。
  function toggleGroup(names: string[], enabled: boolean) {
    const key = disabledKey(group);
    commit({ ...draftRef.current, [key]: applyGroupEnabled(draftRef.current[key], names, enabled) });
  }

  return (
    <PageFrame
      title="Capabilities"
      path="config.json · capabilityDefaults"
      actions={
        <div className="toolbar">
          <Button variant="default" icon={<RefreshIcon size={15} />} onClick={() => void load()} loading={loading}>
            刷新
          </Button>
        </div>
      }
    >
      <div className="capability-page">
        <p className="capability-note">
          这里决定<strong>新会话</strong>
          的默认能力：没有在会话里单独调过开关的会话跟着这里走，调过的会话保留自己的选择。需要时在会话里用
          <code>/capabilities</code>
          （终端）或输入框旁的能力面板（桌面端）改动。
        </p>
        {error ? <Alert message={error} /> : null}
        {loading && !details ? (
          <div className="page-loading">正在加载默认能力…</div>
        ) : (
          <section className="simple-card capability-card">
            {/* 与会话弹窗（桌面端输入框旁的「会话能力」）是同一个列表组件 */}
            <CapabilityList
              groups={GROUPS.map((key) => ({ key, label: GROUP_LABEL[key], disabledKey }))}
              group={group}
              onGroupChange={(key) => {
                setGroup(key as Group);
                setDetail(null);
              }}
              counts={Object.fromEntries(GROUPS.map((key) => [key, capabilityCount(details, draft, key)]))}
              items={items}
              countLabel={`${enabledCount} / ${items.length} 默认启用`}
              status={status === 'saving' ? '· 保存中…' : status === 'saved' ? '· 已保存' : null}
              isEnabled={(name) => !disabled.includes(name)}
              onToggle={(name, checked) => toggle(name, checked)}
              onToggleGroup={group === 'tools' ? toggleGroup : null}
              onOpenDetail={(item) => setDetail(item)}
            />
          </section>
        )}
        {detail ? (
          <Modal
            title={
              <span className="capability-detail-title">
                <code>{detail.name}</code>
              </span>
            }
            onClose={() => setDetail(null)}
            wide
          >
            <div className="capability-detail">
              {detail.readOnly == null ? null : (
                <div className="capability-detail-fact">
                  <span className="capability-detail-label">读写</span>
                  <span className="capability-detail-value">
                    {detail.readOnly ? '只读 · 不会改动工作区' : '非只读 · 不进只读批量并发，也不会随 turn 自动重试'}
                  </span>
                </div>
              )}
              <div className="capability-detail-fact is-block">
                <span className="capability-detail-label">说明</span>
                <p className="capability-detail-text">{detail.description || '没有提供描述。'}</p>
              </div>
              <CapabilityParameters parameters={detail.parameters} />
            </div>
          </Modal>
        ) : null}
      </div>
    </PageFrame>
  );
}

function disabledKey(group: Group): keyof Draft {
  if (group === 'skills') return 'disabledSkills';
  if (group === 'tools') return 'disabledTools';
  return 'disabledMcpServers';
}

function capabilityCount(details: ConfigWebCapabilityDefaults | null, draft: Draft, group: Group): string {
  if (!details) return '';
  const names =
    group === 'skills'
      ? details.skills.map((item) => item.name)
      : group === 'tools'
        ? details.tools.map((item) => item.name)
        : details.mcpServers;
  const disabled = draft[disabledKey(group)];
  return `${names.filter((name) => !disabled.includes(name)).length}/${names.length}`;
}

type SaveStatus = 'saving' | 'saved' | null;

function toDraft(details: ConfigWebCapabilityDefaults): Draft {
  return {
    disabledSkills: details.disabledSkills,
    disabledTools: details.disabledTools,
    disabledMcpServers: details.disabledMcpServers,
  };
}

function clearSavedTimer(ref: { current: number | null }): void {
  if (ref.current === null) return;
  window.clearTimeout(ref.current);
  ref.current = null;
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
