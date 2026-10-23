import { useEffect, useMemo, useState } from 'react';
import { JsonEditor } from '../components/JsonEditor.js';
import { PageFrame } from '../components/PageFrame.js';
import { ProviderEditor } from '../components/ProviderEditor.js';
import { confirmDialog } from '../components/DialogHost.js';
import { Alert, Button, CollapsiblePanel, Empty, Tag } from '../components/Ui.js';
import { readConfigFile, writeConfigFile } from '../api.js';
import { appIcons } from '../icons.js';
import {
  addProviderDraft,
  capabilityDefaultsSummary,
  extraConfigKeys,
  issueMap,
  mcpServerCount,
  parseConfigDraft,
  providerEntries,
  readSearxngUrl,
  removeProviderDraft,
  serializeConfigDraft,
  validateConfigDraft,
  writeProviderDraft,
  writeSearxngUrl,
  type ConfigDraft,
} from '../configDraft.js';
import type { ConfigWebAppSection } from '../layout/Sidebar.js';

type ConfigPageProps = {
  onDirtyChange?(dirty: boolean): void;
  /** 「由其他页面管理」里的跳转；桌面端与浏览器宿主都从 App 传下来。 */
  onNavigate?(section: ConfigWebAppSection): void;
};

/**
 * config.json 的配置页。
 *
 * 以前这里是个裸 JSON 编辑器：字段全靠记，写错一个逗号就保存不了。现在按字段编辑——
 * 表单只覆盖有结构的部分（providers / searxngUrl），其余内容（mcpServers、
 * capabilityDefaults、未来新增的键）在「直接编辑 JSON」里原样可见可改，保存时不会丢。
 */
export function ConfigPage({ onDirtyChange, onNavigate }: ConfigPageProps) {
  const [draft, setDraft] = useState<ConfigDraft | null>(null);
  const [savedJson, setSavedJson] = useState('');
  const [jsonText, setJsonText] = useState('');
  const [jsonError, setJsonError] = useState<string | null>(null);
  const [path, setPath] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [revealed, setRevealed] = useState<ReadonlySet<number>>(() => new Set());
  const [expanded, setExpanded] = useState<ReadonlySet<number>>(() => new Set());
  const RefreshIcon = appIcons.refresh;
  const SaveIcon = appIcons.save;
  const AddIcon = appIcons.add;

  const issues = useMemo(() => (draft ? validateConfigDraft(draft) : []), [draft]);
  const errors = useMemo(() => issueMap(draft ?? {}), [draft]);
  const dirty = Boolean(draft) && serializeConfigDraft(draft ?? {}) !== savedJson;

  /** 表单改动：draft 与 JSON 文本一起更新，两边永远是同一份内容。 */
  function applyDraft(next: ConfigDraft) {
    setDraft(next);
    setJsonText(serializeConfigDraft(next));
    setJsonError(null);
  }

  /** 新增服务商后直接展开它，否则用户只看到多了一行折起来的摘要。 */
  function addProvider() {
    const next = addProviderDraft(draft ?? {});
    applyDraft(next);
    // 保留用户已经展开的卡片，只把新的一项加进来
    setExpanded((prev) => new Set(prev).add(providerEntries(next).length - 1));
  }

  /** 删除后索引会整体前移，展开/明文这类按序号记录的本地状态要跟着挪。 */
  function removeProvider(index: number) {
    applyDraft(removeProviderDraft(draft ?? {}, index));
    setExpanded((prev) => shiftIndexSet(prev, index));
    setRevealed((prev) => shiftIndexSet(prev, index));
  }

  /** 直接编辑 JSON：解析成功才回写 draft，失败只提示、保留原文。 */
  function applyJsonText(next: string) {
    setJsonText(next);
    const result = parseConfigDraft(next);
    if (!result.draft) {
      setJsonError(result.error);
      return;
    }
    setJsonError(null);
    setDraft(result.draft);
  }

  function applyContent(content: string) {
    const result = parseConfigDraft(content);
    setDraft(result.draft);
    setJsonText(content);
    setJsonError(result.error);
    setSavedJson(result.draft ? serializeConfigDraft(result.draft) : content);
  }

  async function load() {
    if (!(await confirmDiscardChanges())) return;
    setLoading(true);
    setError(null);
    try {
      const payload = await readConfigFile();
      setPath(payload.path ?? '');
      applyContent(payload.content);
    } catch (loadError) {
      setError(formatError(loadError));
    } finally {
      setLoading(false);
    }
  }

  async function save() {
    if (!draft || saving || jsonError || issues.length > 0) return;
    setSaving(true);
    setError(null);
    try {
      const payload = await writeConfigFile(serializeConfigDraft(draft));
      applyContent(payload.content);
      setSaved(true);
      window.setTimeout(() => setSaved(false), 1600);
    } catch (saveError) {
      setError(formatError(saveError));
    } finally {
      setSaving(false);
    }
  }

  function confirmDiscardChanges(): Promise<boolean> {
    return !dirty
      ? Promise.resolve(true)
      : confirmDialog({
          title: '放弃未保存的修改',
          message: '当前配置有未保存的修改，重新加载会丢掉它们。',
          confirmText: '放弃修改',
          danger: true,
        });
  }

  useEffect(() => {
    void load();
    // 首次加载只看这一个入口；confirmDiscardChanges 依赖的 dirty 在初次加载时必为 false。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    onDirtyChange?.(dirty);
    const warnBeforeUnload = (event: BeforeUnloadEvent) => {
      if (!dirty) return;
      event.preventDefault();
    };
    window.addEventListener('beforeunload', warnBeforeUnload);
    return () => {
      window.removeEventListener('beforeunload', warnBeforeUnload);
      onDirtyChange?.(false);
    };
  }, [dirty, onDirtyChange]);

  const providers = draft ? providerEntries(draft) : [];
  const extraKeys = draft ? extraConfigKeys(draft) : [];

  return (
    <PageFrame
      title="配置"
      path={path || undefined}
      actions={
        <div className="toolbar">
          {saved ? <span className="save-status">已保存</span> : null}
          <Button icon={<RefreshIcon size={15} />} title="重新加载" onClick={() => void load()} loading={loading} />
          <Button
            variant="primary"
            icon={<SaveIcon size={15} />}
            onClick={() => void save()}
            loading={saving}
            disabled={loading || !draft || !dirty || Boolean(jsonError) || issues.length > 0}
          >
            保存
          </Button>
        </div>
      }
    >
      <div className="detail-body detail-body-stacked">
        {error ? <Alert message={error} /> : null}
        {jsonError ? <Alert message={`JSON 无法解析，改好之前不能保存：${jsonError}`} /> : null}
        {issues.length > 0 ? <Alert message={`还有 ${issues.length} 处需要修正：${issues[0].message}`} /> : null}
        {loading && !draft ? (
          <div className="page-loading">正在加载配置…</div>
        ) : !draft ? null : (
          <div className="config-stack">
            <section className="simple-card config-card">
              <header className="config-card-head">
                <div className="config-head-copy">
                  <h2>服务商</h2>
                  <p>
                    {providers.length > 0
                      ? `${providers.length} 个服务商，决定可选的模型与鉴权`
                      : '至少需要一个服务商才能发送消息'}
                  </p>
                </div>
                <Button icon={<AddIcon size={15} />} disabled={saving} onClick={addProvider}>
                  添加服务商
                </Button>
              </header>

              {providers.length === 0 ? (
                <Empty description="还没有服务商，按「添加服务商」开始" />
              ) : (
                <div className="config-provider-list">
                  {providers.map((raw, index) => (
                    <ProviderEditor
                      key={index}
                      raw={raw}
                      index={index}
                      removable={providers.length > 1}
                      disabled={saving}
                      errorFor={(field) => errors.get(`providers.${index}.${field}`)}
                      hasError={[...errors.keys()].some((key) => key.startsWith(`providers.${index}.`))}
                      expanded={expanded.has(index)}
                      revealed={revealed.has(index)}
                      onToggleExpanded={() =>
                        setExpanded((prev) => {
                          const next = new Set(prev);
                          if (next.has(index)) next.delete(index);
                          else next.add(index);
                          return next;
                        })
                      }
                      onToggleReveal={() =>
                        setRevealed((prev) => {
                          const next = new Set(prev);
                          if (next.has(index)) next.delete(index);
                          else next.add(index);
                          return next;
                        })
                      }
                      onChange={(next) => applyDraft(writeProviderDraft(draft, index, next))}
                      onRemove={() => removeProvider(index)}
                    />
                  ))}
                </div>
              )}
            </section>

            <section className="simple-card config-card">
              <header className="config-card-head">
                <div className="config-head-copy">
                  <h2>联网搜索</h2>
                  <p>联网检索走的 SearXNG 实例（web_search 工具）</p>
                </div>
              </header>
              <label className="form-field">
                <span>SearXNG 地址</span>
                <input
                  className={errors.has('searxngUrl') ? 'text-input text-input-invalid' : 'text-input'}
                  value={readSearxngUrl(draft)}
                  disabled={saving}
                  spellCheck={false}
                  placeholder="http://127.0.0.1:8080"
                  aria-invalid={errors.has('searxngUrl')}
                  onChange={(event) => applyDraft(writeSearxngUrl(draft, event.target.value))}
                />
                {errors.has('searxngUrl') ? (
                  <span className="config-field-error">{errors.get('searxngUrl')}</span>
                ) : null}
              </label>
              <ul className="config-rules">
                <li>留空时按环境变量 SEARXNG_URL、最后回退到 http://127.0.0.1:8080。</li>
                <li>实例需要开启 JSON 输出格式，否则 web_search 拿不到结果。</li>
              </ul>
            </section>

            <section className="simple-card config-card">
              <header className="config-card-head">
                <div className="config-head-copy">
                  <h2>其他页面管理</h2>
                  <p>这些字段同样写在 config.json，但各有专门的编辑页</p>
                </div>
              </header>
              <div className="config-managed-list">
                <div className="config-managed-row">
                  <div className="config-managed-copy">
                    <span className="config-managed-name">MCP 服务</span>
                    <span className="config-managed-desc">
                      {mcpServerCount(draft) > 0 ? `${mcpServerCount(draft)} 个，写在 mcpServers` : '还没有配置'}
                    </span>
                  </div>
                  {onNavigate ? <Button onClick={() => onNavigate('mcp')}>去 MCP 页面</Button> : null}
                </div>
                <div className="config-managed-row">
                  <div className="config-managed-copy">
                    <span className="config-managed-name">新会话默认能力</span>
                    <span className="config-managed-desc">
                      {capabilityDefaultsSummary(draft)}，写在 capabilityDefaults
                    </span>
                  </div>
                  {onNavigate ? <Button onClick={() => onNavigate('capabilities')}>去 Capabilities</Button> : null}
                </div>
              </div>
            </section>

            {extraKeys.length > 0 ? (
              <section className="simple-card config-card">
                <header className="config-card-head">
                  <div className="config-head-copy">
                    <h2>其他字段</h2>
                    <p>表单没有覆盖的键，保存时原样保留，可在「直接编辑 JSON」里修改</p>
                  </div>
                </header>
                <ul className="config-extra-list">
                  {extraKeys.map((key) => (
                    <li className="config-extra-row" key={key}>
                      <span className="config-extra-key">{key}</span>
                      <span className="config-extra-value" title={previewValue(draft[key])}>
                        {previewValue(draft[key])}
                      </span>
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}

            <CollapsiblePanel
              title="直接编辑 JSON"
              subtitle="整份 config.json，解析通过后表单会同步"
              defaultOpen={Boolean(jsonError)}
              meta={jsonError ? <Tag tone="red">解析失败</Tag> : <Tag>可整份替换</Tag>}
            >
              <div className="editor-host config-json-host">
                <JsonEditor value={jsonText} language="json" readOnly={saving} onChange={applyJsonText} />
              </div>
            </CollapsiblePanel>
          </div>
        )}
      </div>
    </PageFrame>
  );
}

/** 删掉第 removed 项后，把记录序号的状态整体前移，超过末尾的直接丢弃。 */
function shiftIndexSet(source: ReadonlySet<number>, removed: number): ReadonlySet<number> {
  const next = new Set<number>();
  for (const index of source) {
    if (index < removed) next.add(index);
    else if (index > removed) next.add(index - 1);
  }
  return next;
}

function previewValue(value: unknown): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  if (!text) return '（空）';
  return text.length > 120 ? `${text.slice(0, 120)}…` : text;
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
