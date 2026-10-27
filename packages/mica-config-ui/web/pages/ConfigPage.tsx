import { useEffect, useMemo, useRef, useState } from 'react';
import { JsonEditor } from '../components/JsonEditor.js';
import { PageFrame } from '../components/PageFrame.js';
import { ProviderEditor } from '../components/ProviderEditor.js';
import { Alert, Button, CollapsiblePanel, SaveStatus, SettingRow, SettingsGroup, Tag } from '../components/Ui.js';
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
  removeProviderDraft,
  serializeConfigDraft,
  validateConfigDraft,
  writeProviderDraft,
  type ConfigDraft,
} from '../configDraft.js';
import type { ConfigWebAppSection } from '../layout/Sidebar.js';
import type { ConfigWebFilePayload } from '../../src/shared/types.js';
import { useAutoSave } from '../useAutoSave.js';

type ConfigPageProps = {
  /** 「由其他页面管理」里的跳转；桌面端与浏览器宿主都从 App 传下来。 */
  onNavigate?(section: ConfigWebAppSection): void;
};

/**
 * config.json 的配置页。
 *
 * 以前这里是个裸 JSON 编辑器：字段全靠记，写错一个逗号就保存不了。现在按字段编辑——
 * 表单只覆盖有结构的部分（providers），其余内容（mcpServers、
 * capabilityDefaults、未来新增的键）在「直接编辑 JSON」里原样可见可改，写盘时不会丢。
 *
 * 没有保存按钮：改动停下就自动写盘。本地校验不过（必填项没填、JSON 还没写完）时先不写，
 * 页面上照旧提示哪里要修——自动保存的前提是别把一份会让 CLI 起不来的配置落盘。
 */
export function ConfigPage({ onNavigate }: ConfigPageProps) {
  const [draft, setDraft] = useState<ConfigDraft | null>(null);
  const [savedJson, setSavedJson] = useState('');
  const [jsonText, setJsonText] = useState('');
  const [jsonError, setJsonError] = useState<string | null>(null);
  const [path, setPath] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [revealed, setRevealed] = useState<ReadonlySet<number>>(() => new Set());
  const [expanded, setExpanded] = useState<ReadonlySet<number>>(() => new Set());
  const RefreshIcon = appIcons.refresh;
  const AddIcon = appIcons.add;
  const draftRef = useRef<ConfigDraft | null>(null);

  const issues = useMemo(() => (draft ? validateConfigDraft(draft) : []), [draft]);
  const errors = useMemo(() => issueMap(draft ?? {}), [draft]);

  const autoSave = useAutoSave<string, ConfigWebFilePayload>({
    save: writeConfigFile,
    onSaved: (payload, sent) => applySavedContent(payload.content, sent),
  });
  const { schedule, flush } = autoSave;

  useEffect(() => {
    draftRef.current = draft;
  }, [draft]);

  /**
   * 改动当场登记写盘。
   *
   * 不用 effect 兜：改完立刻切页面时，卸载和这次改动落在同一批更新里，被卸载的组件不会
   * 再跑 effect，那一批改动就没人登记了。校验没过（必填项缺、模型列表空）先不写——自动
   * 保存的前提是别把一份会让 CLI 起不来的配置落盘。
   */
  function scheduleIfSavable(next: ConfigDraft) {
    const text = serializeConfigDraft(next);
    if (text === savedJson) return;
    if (validateConfigDraft(next).length > 0) return;
    schedule(text);
  }

  /** 表单改动：draft 与 JSON 文本一起更新，两边永远是同一份内容。 */
  function applyDraft(next: ConfigDraft) {
    setDraft(next);
    setJsonText(serializeConfigDraft(next));
    setJsonError(null);
    scheduleIfSavable(next);
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
    scheduleIfSavable(result.draft);
  }

  function applyContent(content: string) {
    const result = parseConfigDraft(content);
    setDraft(result.draft);
    setJsonText(content);
    setJsonError(result.error);
    setSavedJson(result.draft ? serializeConfigDraft(result.draft) : content);
  }

  /**
   * 写盘成功后同步 draft 与「已保存」基线。
   *
   * 不动 jsonText：用户在「直接编辑 JSON」里手上那份文本（缩进、空行）不该因为一次自动保存
   * 被重排、把光标顶走。期间又改过（sent 与当前草稿不一致）时整段跳过，别把新的输入盖回去。
   */
  function applySavedContent(content: string, sent: string) {
    const current = draftRef.current ?? {};
    if (serializeConfigDraft(current) !== sent) return;
    const result = parseConfigDraft(content);
    if (result.draft) {
      setDraft(result.draft);
      setSavedJson(serializeConfigDraft(result.draft));
      return;
    }
    setSavedJson(content);
  }

  async function load() {
    // 先把路上那几下击键写掉，再按磁盘上的内容重建表单。
    await flush();
    setLoading(true);
    setError(null);
    autoSave.clearError();
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

  useEffect(() => {
    void load();
    // 首次加载只看这一个入口；加载完成后 draft 才会出现。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const providers = draft ? providerEntries(draft) : [];
  const extraKeys = draft ? extraConfigKeys(draft) : [];

  return (
    <PageFrame
      title="配置"
      path={path || undefined}
      actions={
        <div className="toolbar">
          <SaveStatus saving={autoSave.saving} saved={autoSave.status === 'saved'} />
          <Button icon={<RefreshIcon size={15} />} onClick={() => void load()} loading={loading}>
            重新加载
          </Button>
        </div>
      }
    >
      <div className="config-page">
        {error ? <Alert message={error} /> : null}
        {autoSave.error ? <Alert message={autoSave.error} /> : null}
        {jsonError ? <Alert message={`JSON 无法解析，改好之前不会写盘：${jsonError}`} /> : null}
        {issues.length > 0 ? <Alert message={`还有 ${issues.length} 处需要修正：${issues[0].message}`} /> : null}
        {loading && !draft ? (
          <div className="page-loading">正在加载配置…</div>
        ) : !draft ? null : (
          <div className="config-page-body">
            <SettingsGroup
              title="服务商"
              description={
                providers.length > 0
                  ? `${providers.length} 个服务商决定可选的模型与鉴权`
                  : '至少需要一个服务商才能发送消息'
              }
              actions={
                <Button icon={<AddIcon size={15} />} onClick={addProvider}>
                  添加服务商
                </Button>
              }
            >
              {providers.length === 0 ? (
                <p className="settings-empty">还没有服务商，按右上角「添加服务商」开始。</p>
              ) : (
                providers.map((raw, index) => (
                  <ProviderEditor
                    key={index}
                    raw={raw}
                    index={index}
                    removable={providers.length > 1}
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
                ))
              )}
            </SettingsGroup>

            <SettingsGroup title="其他页面管理" description="同样写在 config.json，各有专门的编辑页">
              <SettingRow label="MCP 服务">
                <div className="setting-row-inline">
                  <span className="setting-row-value">
                    {mcpServerCount(draft) > 0 ? `${mcpServerCount(draft)} 个已配置` : '还没有配置'}
                  </span>
                  <code className="setting-row-key">mcpServers</code>
                  {onNavigate ? (
                    <Button variant="ghost" onClick={() => onNavigate('mcp')}>
                      去 MCP 页面
                    </Button>
                  ) : null}
                </div>
              </SettingRow>
              <SettingRow label="新会话默认能力">
                <div className="setting-row-inline">
                  <span className="setting-row-value">{capabilityDefaultsSummary(draft)}</span>
                  <code className="setting-row-key">capabilityDefaults</code>
                  {onNavigate ? (
                    <Button variant="ghost" onClick={() => onNavigate('capabilities')}>
                      去 Capabilities
                    </Button>
                  ) : null}
                </div>
              </SettingRow>
            </SettingsGroup>

            {extraKeys.length > 0 ? (
              <SettingsGroup title="其他字段" description="表单没有覆盖的键，保存时原样保留">
                {extraKeys.map((key) => (
                  <SettingRow key={key} label={<code>{key}</code>}>
                    <span className="setting-row-value is-mono" title={previewValue(draft[key])}>
                      {previewValue(draft[key])}
                    </span>
                  </SettingRow>
                ))}
              </SettingsGroup>
            ) : null}

            <CollapsiblePanel
              title="直接编辑 JSON"
              subtitle="整份 config.json，解析通过后表单会同步"
              defaultOpen={Boolean(jsonError)}
              meta={jsonError ? <Tag tone="red">解析失败</Tag> : <Tag>可整份替换</Tag>}
            >
              <div className="editor-host config-json-host">
                <JsonEditor value={jsonText} language="json" onChange={applyJsonText} />
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
