import { useEffect, useMemo, useRef, useState } from 'react';
import { readMcpDetails, writeMcpServers } from '../api.js';
import { confirmDialog } from '../components/DialogHost.js';
import { JsonEditor } from '../components/JsonEditor.js';
import { McpServerCard } from '../components/McpServerCard.js';
import { PageFrame } from '../components/PageFrame.js';
import { Alert, Button, SaveStatus, SettingsGroup } from '../components/Ui.js';
import { appIcons } from '../icons.js';
import {
  addMcpServerEntry,
  mcpIssueMap,
  parseMcpServersDraft,
  removeMcpServerEntry,
  replaceMcpServerEntry,
  serializeMcpServersDraft,
  validateMcpServersDraft,
  type McpServerEntry,
} from '../mcpDraft.js';
import { useAutoSave } from '../useAutoSave.js';
import type { ConfigWebMcpDetails } from '../../src/shared/types.js';

/**
 * config.json 的 `mcpServers`。
 *
 * 一个 server 一张卡片：折叠时是一行摘要（名称 / 连接方式 / 命令或地址 / 状态），展开后是
 * 同一块面里的字段行——和服务商、插件设置页是同一种形态，不再用「左列表 + 右编辑器」。
 *
 * 协议只有两种、字段是固定的几个，所以表单能覆盖全部内容；右上角「编辑 JSON」换成整份
 * `mcpServers`（文档里抄来的 `{ "mcpServers": { … } }` 也认），两边是同一份内容的两种形态。
 *
 * 没有保存按钮：改动停下就整份写盘。校验不过（名称空 / 命令或地址空 / JSON 还没写完）时
 * 先不写，页面上照旧提示哪张卡片的哪个字段要修。
 */
export function McpPage() {
  const [details, setDetails] = useState<ConfigWebMcpDetails | null>(null);
  const [entries, setEntries] = useState<McpServerEntry[] | null>(null);
  const [savedJson, setSavedJson] = useState('');
  const [jsonText, setJsonText] = useState('');
  const [jsonError, setJsonError] = useState<string | null>(null);
  /** 整份 JSON 编辑：表单与编辑器是同一份内容的两种形态，切换不丢内容。 */
  const [jsonMode, setJsonMode] = useState(false);
  const [expanded, setExpanded] = useState<ReadonlySet<number>>(() => new Set());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const entriesRef = useRef<McpServerEntry[] | null>(null);
  const RefreshIcon = appIcons.refresh;
  const AddIcon = appIcons.add;
  const JsonIcon = appIcons.config;

  const issues = useMemo(() => (entries ? validateMcpServersDraft(entries) : []), [entries]);
  const errors = useMemo(() => mcpIssueMap(issues), [issues]);
  const serverByName = useMemo(
    () => new Map((details?.servers ?? []).map((server) => [server.name, server])),
    [details],
  );

  const autoSave = useAutoSave<string, ConfigWebMcpDetails>({
    save: writeMcpServers,
    onSaved: (next, sent) => applySaved(next, sent),
  });
  const { schedule, flush } = autoSave;

  useEffect(() => {
    entriesRef.current = entries;
  }, [entries]);

  /**
   * 改动当场登记写盘。
   *
   * 不用 effect 兜：改完立刻切页面时，卸载和这次改动落在同一批更新里，被卸载的组件不会再
   * 跑 effect，那一批改动就没人登记了。校验没过先不写——自动保存的前提是别把一份会让
   * 会话起不来的 mcpServers 落盘。
   */
  function scheduleIfSavable(next: McpServerEntry[]) {
    const text = serializeMcpServersDraft(next);
    if (text === savedJson) return;
    if (validateMcpServersDraft(next).length > 0) return;
    schedule(text);
  }

  /** 卡片改动：整份内容一起更新，可写就登记写盘。 */
  function applyEntries(next: McpServerEntry[]) {
    setEntries(next);
    setJsonError(null);
    scheduleIfSavable(next);
  }

  /** 直接编辑 JSON：解析成功才回写卡片，失败只提示、保留原文。 */
  function applyJsonText(next: string) {
    setJsonText(next);
    const result = parseMcpServersDraft(next);
    if (!result.entries) {
      setJsonError(result.error);
      return;
    }
    setJsonError(null);
    setEntries(result.entries);
    scheduleIfSavable(result.entries);
  }

  function applyContent(content: string) {
    const result = parseMcpServersDraft(content);
    setEntries(result.entries);
    // 每次按磁盘重建都把卡片摊开：一两个 server 时折起来只会让人多点一次。
    setExpanded(new Set((result.entries ?? []).map((_, index) => index)));
    setJsonText(content);
    setJsonError(result.error);
    setSavedJson(result.entries ? serializeMcpServersDraft(result.entries) : content);
    // 磁盘上那份已经解析不了：直接摊开编辑器让人当场改，而不是留一列改不动的卡片。
    if (result.error) setJsonMode(true);
  }

  /**
   * 写盘成功后同步卡片与「已保存」基线。
   *
   * 不动 jsonText：用户在「编辑 JSON」里手上那份文本（缩进、空行）不该因为一次自动保存
   * 被重排、把光标顶走。期间又改过（发送值与当前内容不一致）时整段跳过。
   */
  function applySaved(next: ConfigWebMcpDetails, sent: string) {
    const current = entriesRef.current;
    setDetails(next);
    if (!current || serializeMcpServersDraft(current) !== sent) return;
    const result = parseMcpServersDraft(next.content);
    if (!result.entries) return;
    setEntries(result.entries);
    setSavedJson(serializeMcpServersDraft(result.entries));
  }

  async function load() {
    // 先把路上那几下击键写掉，再按磁盘上的内容重建卡片。
    await flush();
    setLoading(true);
    setError(null);
    autoSave.clearError();
    try {
      const payload = await readMcpDetails();
      setDetails(payload);
      applyContent(payload.content);
    } catch (loadError) {
      setError(formatError(loadError));
    } finally {
      setLoading(false);
    }
  }

  function toggleJsonMode() {
    if (jsonMode) {
      setJsonMode(false);
      return;
    }
    setJsonText(serializeMcpServersDraft(entries ?? []));
    setJsonError(null);
    setJsonMode(true);
  }

  function addServer() {
    const next = addMcpServerEntry(entries ?? []);
    applyEntries(next);
    // 新卡片直接展开：命令还空着，一眼看到该填哪里。
    setExpanded((prev) => new Set(prev).add(next.length - 1));
  }

  async function removeServer(index: number) {
    const entry = entries?.[index];
    if (!entry) return;
    const confirmed = await confirmDialog({
      title: `删除 MCP server「${entry.name.trim() || '未命名'}」`,
      message: '这张卡的配置会从 config.json 里删掉，无法撤销。',
      confirmText: '删除',
      danger: true,
    });
    if (!confirmed) return;
    applyEntries(removeMcpServerEntry(entries ?? [], index));
    setExpanded((prev) => shiftIndexSet(prev, index));
  }

  useEffect(() => {
    void load();
    // 首次加载只看这一个入口。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <PageFrame
      title="MCP"
      description="config.json 的 mcpServers：一张卡片一个 server，需要时再切到整份 JSON"
      path={details?.path}
      actions={
        <div className="toolbar">
          <SaveStatus saving={autoSave.saving} saved={autoSave.status === 'saved'} />
          <Button icon={<JsonIcon size={15} />} pressed={jsonMode} onClick={toggleJsonMode}>
            {jsonMode ? '返回表单' : '编辑 JSON'}
          </Button>
          <Button icon={<RefreshIcon size={15} />} title="重新加载" onClick={() => void load()} loading={loading} />
        </div>
      }
    >
      <div className={`config-page${jsonMode ? ' is-json' : ''}`}>
        {error ? <Alert message={error} /> : null}
        {autoSave.error ? <Alert message={autoSave.error} /> : null}
        {jsonError ? <Alert message={`JSON 无法解析，改好之前不会写盘：${jsonError}`} /> : null}
        {issues.length > 0 ? <Alert message={`还有 ${issues.length} 处需要修正：${issues[0].message}`} /> : null}
        {loading && !entries ? (
          <div className="page-loading">正在加载 MCP 配置…</div>
        ) : jsonMode ? (
          <div className="config-page-body config-page-body-json">
            <div className="editor-host config-json-host">
              <JsonEditor value={jsonText} language="json" onChange={applyJsonText} />
            </div>
          </div>
        ) : entries ? (
          <div className="config-page-body">
            <SettingsGroup
              title="MCP server"
              description={
                entries.length > 0
                  ? `${entries.length} 个 server 决定会话里能用到哪些 MCP 工具`
                  : '还没有 MCP server：本地进程填命令，HTTP 填端点地址'
              }
              actions={
                <Button icon={<AddIcon size={15} />} onClick={addServer}>
                  添加 server
                </Button>
              }
            >
              {entries.length === 0 ? (
                <p className="settings-empty">按右上角「添加 server」开始；也能在「编辑 JSON」里整份粘进来。</p>
              ) : (
                entries.map((entry, index) => (
                  <McpServerCard
                    key={index}
                    entry={entry}
                    index={index}
                    server={serverByName.get(entry.name.trim())}
                    expanded={expanded.has(index)}
                    hasError={[...errors.keys()].some((key) => key.startsWith(`servers.${index}.`))}
                    errorFor={(field) => errors.get(`servers.${index}.${field}`)}
                    onChange={(next) => applyEntries(replaceMcpServerEntry(entries, index, next))}
                    onToggleExpanded={() =>
                      setExpanded((prev) => {
                        const next = new Set(prev);
                        if (next.has(index)) next.delete(index);
                        else next.add(index);
                        return next;
                      })
                    }
                    onRemove={() => void removeServer(index)}
                  />
                ))
              )}
            </SettingsGroup>
          </div>
        ) : null}
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

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
