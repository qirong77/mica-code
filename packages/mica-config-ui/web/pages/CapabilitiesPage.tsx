import { useCallback, useEffect, useMemo, useState } from 'react';
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
 * 新会话默认能力。只写入 config.json 的 `capabilityDefaults`：已有会话保留自己的
 * snapshot，因此改这里不会动到任何人正在用的对话。会话内的开关在 `/capabilities`
 * （CLI）或输入框旁的能力面板（桌面端）。
 */
export function CapabilitiesPage({ onDirtyChange }: { onDirtyChange?(dirty: boolean): void }) {
  const [details, setDetails] = useState<ConfigWebCapabilityDefaults | null>(null);
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  const [group, setGroup] = useState<Group>('tools');
  const [detail, setDetail] = useState<Item | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const RefreshIcon = appIcons.refresh;
  const SaveIcon = appIcons.save;

  const applyDetails = useCallback((next: ConfigWebCapabilityDefaults) => {
    setDetails(next);
    setDraft({
      disabledSkills: next.disabledSkills,
      disabledTools: next.disabledTools,
      disabledMcpServers: next.disabledMcpServers,
    });
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      applyDetails(await readCapabilityDefaults());
    } catch (loadError) {
      setError(formatError(loadError));
    } finally {
      setLoading(false);
    }
  }, [applyDetails]);

  useEffect(() => {
    void load();
  }, [load]);

  const dirty = useMemo(
    () =>
      JSON.stringify(draft) !==
      JSON.stringify(
        details
          ? {
              disabledSkills: details.disabledSkills,
              disabledTools: details.disabledTools,
              disabledMcpServers: details.disabledMcpServers,
            }
          : EMPTY_DRAFT,
      ),
    [details, draft],
  );

  useEffect(() => {
    onDirtyChange?.(dirty);
  }, [dirty, onDirtyChange]);

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
    setDraft((current) => {
      const key = disabledKey(group);
      const next = new Set(current[key]);
      if (enabled) next.delete(name);
      else next.add(name);
      return { ...current, [key]: [...next] };
    });
  }

  // 整组开关：一次改写组内全部成员，落到同一个禁用名单里（能力校验按工具名逐条判定）。
  function toggleGroup(names: string[], enabled: boolean) {
    setDraft((current) => {
      const key = disabledKey(group);
      return { ...current, [key]: applyGroupEnabled(current[key], names, enabled) };
    });
  }

  async function save() {
    setSaving(true);
    setError(null);
    try {
      applyDetails(await writeCapabilityDefaults(draft));
      setSaved(true);
      window.setTimeout(() => setSaved(false), 1600);
    } catch (saveError) {
      setError(formatError(saveError));
    } finally {
      setSaving(false);
    }
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
          <Button
            icon={<SaveIcon size={15} />}
            onClick={() => void save()}
            loading={saving}
            disabled={loading || !dirty}
          >
            保存
          </Button>
        </div>
      }
    >
      <div className="capability-page">
        <p className="capability-note">
          这里只决定<strong>新建会话</strong>的默认能力。已有会话保留自己的开关，需要时在会话里用
          <code>/capabilities</code>（终端）或输入框旁的能力面板（桌面端）调整。
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
              counts={Object.fromEntries(GROUPS.map((key) => [key, capabilityCount(details, key)]))}
              items={items}
              countLabel={`${enabledCount} / ${items.length} 默认启用`}
              status={dirty ? '· 改动未保存' : !dirty && saved ? '· 已保存' : null}
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
                    {detail.readOnly ? '只读 · 不会改动工作区' : '可写 · 会改动文件或执行命令'}
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

function capabilityCount(details: ConfigWebCapabilityDefaults | null, group: Group): string {
  if (!details) return '';
  const names =
    group === 'skills'
      ? details.skills.map((item) => item.name)
      : group === 'tools'
        ? details.tools.map((item) => item.name)
        : details.mcpServers;
  const disabled = details[disabledKey(group)];
  return `${names.filter((name) => !disabled.includes(name)).length}/${names.length}`;
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
