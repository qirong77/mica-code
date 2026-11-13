import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { PromptControls } from '@packages/mica-common/promptControls.js';
import { PageFrame } from '../components/PageFrame.js';
import { Alert, Button, Empty, SaveStatus, Segmented, SettingsGroup, Switch, Tag } from '../components/Ui.js';
import { Input } from '../components/ArcoSettings.js';
import { CapabilityList, CapabilityParameters, type CapabilityItem } from '../components/CapabilityList.js';
import { PromptControlsPanel } from '../components/PromptControlsPanel.js';
import { JsonEditor } from '../components/JsonEditor.js';
import { applyGroupEnabled, capabilityToggleNames } from '../capabilityGroups.js';
import { Modal } from '../components/Modal.js';
import { readCapabilityDefaults, writeCapabilityDefaults, readPromptControls, writePromptControls } from '../api.js';
import { CAPABILITY_LABELS as L, pluginLoadStatusLabel, pluginSourceLabel, mcpStatusLabel } from '../labels.js';
import { setPluginPromptEnabled } from '../promptControlDraft.js';
import {
  capabilityDraftCache,
  promptDraftCache,
  readStableCapabilityState,
  serializeCapabilityWrite,
  type CapabilityDraft,
} from '../capabilityDrafts.js';
import { useAutoSave } from '../useAutoSave.js';
import { appIcons } from '../icons.js';
import type {
  ConfigWebCapabilitiesRuntime,
  ConfigWebCapabilityDefaults,
  ConfigWebRuntimeCapabilities,
  ConfigWebCapabilityTool,
} from '../../src/shared/types.js';

type Scope = 'runtime' | 'defaults';
type Group = 'skills' | 'tools' | 'mcpServers';
type Tab = Group | 'plugins' | 'prompts';
type Draft = { disabledSkills: string[]; disabledTools: string[]; disabledMcpServers: string[] };
type Item = CapabilityItem & { mcpTools?: ConfigWebCapabilityTool[] };
const TABS: Tab[] = ['tools', 'skills', 'mcpServers', 'plugins', 'prompts'];
const EMPTY: Draft = { disabledSkills: [], disabledTools: [], disabledMcpServers: [] };
const EMPTY_CONTROLS: PromptControls = { version: 1, disabledPlugins: [], sections: {} };

/** 默认配置与当前会话共用页面，真实目录始终由会话宿主提供。 */
export function CapabilitiesPage({ runtime }: { runtime?: ConfigWebCapabilitiesRuntime }) {
  const [details, setDetails] = useState<ConfigWebCapabilityDefaults | null>(null);
  const [live, setLive] = useState<ConfigWebRuntimeCapabilities | null>(null);
  const [scope, setScope] = useState<Scope>(runtime ? 'runtime' : 'defaults');
  const [drafts, setDrafts] = useState<Record<Scope, Draft>>({ runtime: EMPTY, defaults: EMPTY });
  const draftsRef = useRef(drafts);
  const [controls, setControls] = useState<PromptControls | null>(null);
  const [tab, setTab] = useState<Tab>('tools');
  const [query, setQuery] = useState('');
  const [detail, setDetail] = useState<Item | null>(null);
  const [promptId, setPromptId] = useState('preview');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [draftError, setDraftError] = useState<string | null>(null);
  const loadVersion = useRef(0);
  const RefreshIcon = appIcons.refresh;

  const capabilitySave = useAutoSave<CapabilityDraft, unknown>({
    save: async (next) => {
      try {
        if (next.scope === 'runtime') {
          if (!next.target) throw new Error('当前没有可用的会话宿主');
          return await serializeCapabilityWrite(next.key, () =>
            next.target!.setSelection({ version: 1, ...next.selection }),
          );
        }
        return await serializeCapabilityWrite(next.key, () => writeCapabilityDefaults(next.selection));
      } catch (cause) {
        capabilityDraftCache.fail(next.key, next, formatError(cause));
        throw cause;
      }
    },
    onSaved: (_result, saved) => {
      capabilityDraftCache.confirm(saved.key, saved);
      clearRecoveredDraftError();
    },
  });
  const promptSave = useAutoSave<PromptControls, PromptControls>({
    save: async (next) => {
      try {
        return await serializeCapabilityWrite('prompt-controls', () => writePromptControls(next));
      } catch (cause) {
        promptDraftCache.fail('global', next, formatError(cause));
        throw cause;
      }
    },
    onSaved: (_result, saved) => {
      promptDraftCache.confirm('global', saved);
      clearRecoveredDraftError();
    },
  });

  function clearRecoveredDraftError() {
    if (
      !promptDraftCache.read('global') &&
      !capabilityDraftCache.read('defaults') &&
      !capabilityDraftCache.read(`runtime:${runtime?.key ?? 'current'}`)
    )
      setDraftError(null);
  }

  const load = useCallback(async () => {
    const version = ++loadVersion.current;
    setLoading(true);
    setError(null);
    const results = await readStableCapabilityState(() =>
      Promise.allSettled([
        readCapabilityDefaults(),
        readPromptControls(),
        runtime?.read() ?? Promise.resolve(null),
      ]),
    );
    if (version !== loadVersion.current) return;
    const [defaultsResult, controlsResult, liveResult] = results;
    const failures: string[] = [];
    const nextDrafts = { ...draftsRef.current };
    if (defaultsResult.status === 'fulfilled') {
      setDetails(defaultsResult.value);
      nextDrafts.defaults = toDraft(defaultsResult.value);
    } else failures.push(formatError(defaultsResult.reason));
    if (controlsResult.status === 'fulfilled') {
      setControls(controlsResult.value);
    } else failures.push(formatError(controlsResult.reason));
    if (liveResult.status === 'fulfilled') {
      setLive(liveResult.value);
      if (liveResult.value) nextDrafts.runtime = toDraft(liveResult.value.selection);
    } else {
      setLive(null);
      failures.push(`会话能力：${formatError(liveResult.reason)}`);
    }
    const restored: string[] = [];
    for (const key of ['defaults', `runtime:${runtime?.key ?? 'current'}`]) {
      const cached = capabilityDraftCache.read(key);
      if (!cached) continue;
      nextDrafts[cached.value.scope] = cached.value.selection;
      const message = cached.error ?? '有尚未保存的能力选择，请重试保存。';
      restored.push(message);
    }
    const promptDraft = promptDraftCache.read('global');
    if (promptDraft) {
      setControls(promptDraft.value);
      restored.push(promptDraft.error ?? '有尚未保存的提示词草稿，请重试保存。');
    }
    setDraftError(restored.length ? restored.join('\n') : null);
    draftsRef.current = nextDrafts;
    setDrafts(nextDrafts);
    setError(failures.length ? failures.join('\n') : null);
    setLoading(false);
  }, [runtime]);

  useEffect(() => {
    void load();
    return () => {
      loadVersion.current += 1;
    };
  }, [load]);

  async function flush() {
    await Promise.all([capabilitySave.flush(), promptSave.flush()]);
    const keys = ['defaults', `runtime:${runtime?.key ?? 'current'}`];
    for (const key of keys) {
      const cached = capabilityDraftCache.read(key);
      if (!cached) continue;
      capabilitySave.schedule(cached.value);
      await capabilitySave.flush();
    }
    const promptDraft = promptDraftCache.read('global');
    if (promptDraft) {
      promptSave.schedule(promptDraft.value);
      await promptSave.flush();
    }
    const remaining = [...keys.map((key) => capabilityDraftCache.read(key)), promptDraftCache.read('global')].filter(
      Boolean,
    );
    if (remaining.length)
      throw new Error(remaining.map((entry) => entry?.error ?? '草稿尚未保存，请重试。').join('\n'));
  }

  async function refresh() {
    try {
      await flush();
      await load();
    } catch (cause) {
      setError(formatError(cause));
    }
  }

  async function changeScope(next: string) {
    try {
      await flush();
      await load();
      setScope(next as Scope);
      setDetail(null);
    } catch (cause) {
      setError(formatError(cause));
    }
  }

  function commit(next: Draft) {
    const nextDrafts = { ...draftsRef.current, [scope]: next };
    draftsRef.current = nextDrafts;
    setDrafts(nextDrafts);
    const value: CapabilityDraft = {
      scope,
      key: scope === 'defaults' ? 'defaults' : `runtime:${runtime?.key ?? 'current'}`,
      selection: next,
      target: scope === 'runtime' ? runtime : undefined,
    };
    capabilityDraftCache.remember(value.key, value);
    capabilitySave.schedule(value);
  }

  function commitControls(next: PromptControls) {
    setControls(next);
    promptDraftCache.remember('global', next);
    promptSave.schedule(next);
  }

  const tools = useMemo(
    () =>
      scope === 'runtime'
        ? (live?.tools ?? [])
        : mergeNamed(
            details?.tools ?? [],
            (live?.tools ?? []).filter((tool) => tool.group?.key.startsWith('plugin:')),
          ),
    [details, live, scope],
  );
  const skills = scope === 'runtime' ? (live?.skills ?? []) : (details?.skills ?? []);
  const servers =
    scope === 'runtime' ? (live?.mcpServers.map((server) => server.name) ?? []) : (details?.mcpServers ?? []);
  const draft = drafts[scope];
  const plugins = useMemo(() => {
    const byId = new Map((details?.plugins ?? []).map((plugin) => [plugin.id, plugin]));
    for (const plugin of live?.plugins ?? []) {
      if (!byId.has(plugin.id))
        byId.set(plugin.id, {
          id: plugin.id,
          name: plugin.name,
          source: plugin.id.startsWith('user.') ? 'user' : 'official',
          state: 'enabled',
        });
    }
    return [...byId.values()].sort((a, b) => a.name.localeCompare(b.name));
  }, [details, live]);

  const items: Item[] = (
    tab === 'tools'
      ? tools.map((tool) => ({
          ...tool,
          sourceLabel: tool.pluginId
            ? `插件 ${tool.pluginId}`
            : tool.group?.key.startsWith('plugin:')
              ? `插件 ${tool.group.key.slice(7)}`
              : '内置',
        }))
      : tab === 'skills'
        ? skills.map((skill) => ({
            ...skill,
            sourceLabel: skill.pluginId ? `插件 ${skill.pluginId}` : '磁盘技能',
          }))
        : tab === 'mcpServers'
          ? servers.map((name) => {
              const server = live?.mcpServers.find((entry) => entry.name === name);
              const mcpTools = (live?.mcpTools ?? []).filter(
                (tool) =>
                  tool.group?.key === `mcp:${name}` ||
                  (tool as ConfigWebCapabilityTool & { mcpServer?: string }).mcpServer === name,
              );
              return {
                name,
                description:
                  scope === 'runtime'
                    ? `${mcpStatusLabel(server?.status)} · ${mcpTools.length} 个工具${server?.error ? ` · ${server.error}` : ''}`
                    : 'config.json',
                mcpTools,
              };
            })
          : []
  ).filter((item) =>
    `${item.name} ${item.description} ${'sourceLabel' in item ? item.sourceLabel : ''} ${'group' in item ? (item.group?.label ?? '') : ''}`
      .toLowerCase()
      .includes(query.toLowerCase()),
  );

  const count = (group: Group) => {
    const names =
      group === 'tools'
        ? tools.map((tool) => tool.name)
        : group === 'skills'
          ? skills.map((skill) => skill.name)
          : servers;
    return `${names.filter((name) => !draft[disabledKey(group)].includes(name)).length}/${names.length}`;
  };
  const counts: Record<Tab, string> = {
    tools: count('tools'),
    skills: count('skills'),
    mcpServers: count('mcpServers'),
    plugins: String(plugins.length),
    prompts: live?.prompt ? String(live.prompt.sections.length) : '',
  };
  const activeGroup: Group = tab === 'tools' || tab === 'skills' || tab === 'mcpServers' ? tab : 'tools';
  const disabled = draft[disabledKey(activeGroup)];
  const ready = scope === 'runtime' ? Boolean(live) : Boolean(details);
  const saving = capabilitySave.saving || promptSave.saving;

  function toggleNames(names: string[], enabled: boolean) {
    const key = disabledKey(activeGroup);
    commit({ ...draftsRef.current[scope], [key]: applyGroupEnabled(draftsRef.current[scope][key], names, enabled) });
  }

  return (
    <PageFrame
      title="Capabilities"
      description={L.description}
      path={
        tab === 'prompts' || tab === 'plugins'
          ? 'prompt-controls.json'
          : scope === 'runtime'
            ? live?.prompt?.cwd
            : 'config.json · capabilityDefaults'
      }
      actions={
        <div className="toolbar">
          <SaveStatus saving={saving} saved={capabilitySave.status === 'saved' || promptSave.status === 'saved'} />
          <Button icon={<RefreshIcon size={15} />} onClick={() => void refresh()} loading={loading} disabled={saving}>
            刷新
          </Button>
        </div>
      }
    >
      <div className="capability-page">
        <div className="capability-scope-bar">
          {runtime ? (
            <Segmented
              value={scope}
              options={[
                { value: 'runtime', label: L.currentSession },
                { value: 'defaults', label: L.defaults },
              ]}
              onChange={(next) => void changeScope(next)}
              ariaLabel="能力范围"
              disabled={loading || saving}
            />
          ) : (
            <Tag>{L.defaults}</Tag>
          )}
          {scope === 'runtime' && live?.prompt ? (
            <span className="capability-scope-fact">
              {live.prompt.role}
              {live.prompt.running ? ' · 正在运行' : ' · 空闲'}
            </span>
          ) : null}
        </div>
        <p className="capability-note">{scope === 'runtime' ? L.runtimeNote : L.defaultsNote}</p>
        {error ? <Alert message={error} /> : null}
        {capabilitySave.error || promptSave.error || draftError ? (
          <div className="capability-save-error">
            <Alert message={capabilitySave.error ?? promptSave.error ?? draftError ?? ''} />
            <Button variant="ghost" onClick={() => void refresh()}>
              重试保存
            </Button>
          </div>
        ) : null}
        <section className="simple-card capability-card">
          <div className="session-tabs" role="tablist" aria-label="能力分类">
            {TABS.map((key) => (
              <button
                key={key}
                type="button"
                role="tab"
                aria-selected={tab === key}
                className={`session-tab${tab === key ? ' session-tab-active' : ''}`}
                onClick={() => {
                  setTab(key);
                  setDetail(null);
                }}
              >
                {L[key]}
                <span className="capability-tab-count">{counts[key]}</span>
              </button>
            ))}
          </div>
          <div className="capability-search">
            <Input allowClear value={query} placeholder={L.search} aria-label="搜索能力" onChange={setQuery} />
          </div>
          {loading && !details && !live ? (
            <div className="page-loading">正在读取能力…</div>
          ) : tab === 'plugins' ? (
            <SettingsGroup title="插件贡献" description={L.promptScope}>
              {plugins
                .filter((plugin) =>
                  `${plugin.id} ${plugin.name} ${plugin.description ?? ''}`.toLowerCase().includes(query.toLowerCase()),
                )
                .map((plugin) => {
                  const actual = live?.plugins.find((entry) => entry.id === plugin.id);
                  const pluginSections =
                    live?.prompt?.sections.filter((section) => section.pluginId === plugin.id) ?? [];
                  return (
                    <div key={plugin.id} className="capability-plugin-row">
                      <div className="capability-plugin-copy">
                        <div>
                          <strong>{plugin.name}</strong>
                          <Tag>{pluginSourceLabel(plugin.source)}</Tag>
                          <Tag>
                            {plugin.state === 'disabled'
                              ? '已停用'
                              : actual
                                ? pluginLoadStatusLabel(actual.status)
                                : pluginLoadStatusLabel(plugin.loadStatus)}
                          </Tag>
                        </div>
                        <code title={plugin.id}>{plugin.id}</code>
                        <p title={plugin.description}>{plugin.description || plugin.error || '未提供描述'}</p>
                        {actual ? (
                          <div className="capability-plugin-contributions">
                            <Button
                              size="compact"
                              variant="ghost"
                              disabled={!actual.toolNames.length}
                              onClick={() => {
                                if (scope !== 'runtime') void changeScope('runtime');
                                setTab('tools');
                                setQuery(plugin.id);
                              }}
                            >
                              {actual.toolNames.length} 个工具
                            </Button>
                            <Button
                              size="compact"
                              variant="ghost"
                              disabled={!actual.skillNames.length}
                              onClick={() => {
                                if (scope !== 'runtime') void changeScope('runtime');
                                setTab('skills');
                                setQuery(plugin.id);
                              }}
                            >
                              {actual.skillNames.length} 个技能
                            </Button>
                            <span>{pluginSections.length} 段提示词</span>
                          </div>
                        ) : (
                          <span>打开当前会话后查看实际贡献</span>
                        )}
                        {actual?.error ? <span>{actual.error}</span> : null}
                      </div>
                      <div className="capability-plugin-actions">
                        {pluginSections.length ? (
                          <Button
                            size="compact"
                            variant="ghost"
                            onClick={() => {
                              setPromptId(pluginSections[0]!.id);
                              setTab('prompts');
                              setQuery('');
                            }}
                          >
                            查看提示词
                          </Button>
                        ) : null}
                        <span>{L.injection}</span>
                        <Switch
                          label={`${plugin.name} 提示词注入`}
                          checked={plugin.state !== 'disabled' && !controls?.disabledPlugins.includes(plugin.id)}
                          disabled={!controls || loading || plugin.state === 'disabled'}
                          onChange={(enabled) =>
                            commitControls(setPluginPromptEnabled(controls ?? EMPTY_CONTROLS, plugin.id, enabled))
                          }
                        />
                      </div>
                    </div>
                  );
                })}
              {!plugins.length ? <Empty description="尚未发现插件" /> : null}
            </SettingsGroup>
          ) : tab === 'prompts' ? (
            controls ? (
              <PromptControlsPanel
                inspection={live?.prompt ?? null}
                controls={controls}
                onChange={commitControls}
                disabled={loading}
                query={query}
                selectedId={promptId}
                onSelect={setPromptId}
              />
            ) : (
              <Empty description="提示词控制配置尚未读取成功，请刷新后重试。" />
            )
          ) : !ready ? (
            <Empty description="未能读取能力目录，请刷新重试。" />
          ) : (
            <CapabilityList
              groups={[]}
              showTabs={false}
              group={tab}
              onGroupChange={() => {}}
              counts={counts}
              items={items}
              countLabel={`${items.filter((item) => !disabled.includes(item.name)).length} / ${items.length} ${scope === 'defaults' ? '默认启用' : '启用'}${scope === 'runtime' && live?.prompt?.running ? ' · 本轮运行中，结束后可调整' : ''}`}
              disabled={loading || (scope === 'runtime' && Boolean(live?.prompt?.running))}
              isEnabled={(name) => !disabled.includes(name)}
              onToggle={(name, enabled) => toggleNames(capabilityToggleNames(items, name), enabled)}
              onToggleGroup={tab === 'tools' ? toggleNames : null}
              onOpenDetail={(item) => setDetail(item)}
            />
          )}
        </section>
        {detail ? (
          <Modal title={<code>{detail.name}</code>} onClose={() => setDetail(null)} wide>
            <div className="capability-detail">
              {detail.sourceLabel ? <p className="capability-note">{detail.sourceLabel}</p> : null}
              {detail.readOnly === undefined ? null : (
                <div className="capability-detail-fact">
                  <span className="capability-detail-label">读写</span>
                  <span>{detail.readOnly ? '只读' : '可执行写入或其他操作'}</span>
                </div>
              )}
              <p className="capability-detail-text">{detail.description || '没有提供描述。'}</p>
              <CapabilityParameters parameters={detail.parameters} />
              {detail.inputSchema ? (
                <div className="editor-host capability-schema-host">
                  <JsonEditor
                    language="json"
                    value={JSON.stringify(detail.inputSchema, null, 2)}
                    readOnly
                    onChange={() => {}}
                  />
                </div>
              ) : null}
              {detail.mcpTools?.map((tool) => (
                <Button
                  key={tool.name}
                  fullWidth
                  variant="ghost"
                  onClick={() => setDetail({ ...tool, sourceLabel: `MCP · ${detail.name}` })}
                >
                  {tool.name}
                </Button>
              ))}
            </div>
          </Modal>
        ) : null}
      </div>
    </PageFrame>
  );
}

function disabledKey(group: Group): keyof Draft {
  return group === 'skills' ? 'disabledSkills' : group === 'tools' ? 'disabledTools' : 'disabledMcpServers';
}
function toDraft(value: Draft): Draft {
  return {
    disabledSkills: value.disabledSkills,
    disabledTools: value.disabledTools,
    disabledMcpServers: value.disabledMcpServers,
  };
}
function mergeNamed<T extends { name: string }>(defaults: T[], extra: T[]): T[] {
  return [...new Map([...defaults, ...extra].map((entry) => [entry.name, entry])).values()].sort((a, b) =>
    a.name.localeCompare(b.name),
  );
}
function formatError(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
