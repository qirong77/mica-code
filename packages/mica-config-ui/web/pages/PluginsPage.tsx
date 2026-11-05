import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { PageFrame } from '../components/PageFrame.js';
import { PluginSettingInput } from '../components/PluginSettingInput.js';
import { Alert, Button, SaveStatus, SettingRow, SettingsGroup, Switch, Tag } from '../components/Ui.js';
import { LlmSettingsSection } from '../components/LlmSettingsSection.js';
import { PathLink } from '../components/PathLink.js';
import { PluginIcon } from '../pluginIcons.js';
import {
  openDesktopSettings,
  readDesktopChecks,
  readPluginsDetails,
  runPluginAction,
  setPluginEnabled,
  supportsPluginSettings,
  supportsPluginToggle,
  testPluginLlm,
  writePluginSettings,
} from '../api.js';
import type {
  ConfigWebDesktopCheckStatus,
  ConfigWebPlugin,
  ConfigWebPluginAction,
  ConfigWebPluginActionResult,
  ConfigWebPluginNewSession,
  ConfigWebPluginsDetails,
} from '../../src/shared/types.js';
import { appIcons } from '../icons.js';
import {
  desktopCheckStatusLabel,
  pluginHostLabel,
  pluginLoadStatusLabel,
  pluginSourceLabel,
  pluginStateLabel,
} from '../labels.js';
import { useAutoSave } from '../useAutoSave.js';

/** 运行条件状态 → 标签色调。未知用中性色：没探测到不等于没问题。 */
const DESKTOP_CHECK_TONE = { granted: 'green', denied: 'red', unknown: 'default' } as const;

/**
 * 插件页：一页卡片目录 + 每个插件自己的整页详情。
 *
 * 两种插件含义不同，页面上必须分开说：
 * - 官方插件随产品分发（源码在仓库 `plugins/`），永远「已安装」，只能启用 / 停用；
 * - 用户插件是 `$MICA_HOME/plugins` 下的插件目录，装没装、能不能加载由磁盘决定。
 *
 * 页面只说两件不同的事：开关表达「此刻是启用还是停用」，卡片脚注表达「上一次装配的结论」
 * （已加载 / 已跳过 / 尚未加载）。两者互补，不重复。设置则写盘就被插件读到，连装配都不用等。
 *
 * 当前打开哪个插件由宿主（`pluginId`）决定：桌面端插件菜单直接落在某个插件的详情上，
 * 侧栏再点一次 Plugins 回到目录。返回按钮同样只回到目录，不回到上一个设置页——插件页是
 * 从哪里打开的，不影响它自己的层级。
 */
export function PluginsPage({
  pluginId = null,
  onSelectPlugin = () => {},
  onNewSession,
  onOpenPluginPage,
}: {
  pluginId?: string | null;
  onSelectPlugin?(pluginId: string | null): void;
  /**
   * 动作要求「开一个新会话去做」时由宿主接手（桌面端会开页签、把提示词放进输入框）。
   *
   * 浏览器宿主没有会话可开，不传：页面那时只如实说「在桌面端里点」。返回值表示有没有真的
   * 跳过去——没有就不能假装已经跳了。
   */
  onNewSession?(task: ConfigWebPluginNewSession): boolean | void;
  /**
   * 打开插件自己的整页（清单 `desktop.page`），由宿主接手：页面本身不画那些整页。
   *
   * 只有随包插件有模块，所以返回值同样要能说「打不开」，页面据此如实提示而不是点了没反应。
   * 浏览器宿主不传：那时整个按钮不出现。
   */
  onOpenPluginPage?(pluginId: string): boolean | void | Promise<boolean | void>;
} = {}) {
  const [details, setDetails] = useState<ConfigWebPluginsDetails | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  const [category, setCategory] = useState<PluginCategory>('desktop');
  const [notice, setNotice] = useState<string | null>(null);
  const canToggle = supportsPluginToggle();
  const canSettings = supportsPluginSettings();

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setDetails(await readPluginsDetails());
    } catch (loadError) {
      setError(formatError(loadError));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const plugins = useMemo(() => details?.plugins ?? [], [details]);
  // 指定的插件可能已从磁盘删除：数据里没有它就退回目录，不留一个空详情。
  const openPlugin = pluginId ? (plugins.find((plugin) => plugin.id === pluginId) ?? null) : null;

  async function toggle(plugin: ConfigWebPlugin, enabled: boolean) {
    setPendingId(plugin.id);
    setError(null);
    setNotice(null);
    try {
      setDetails(await setPluginEnabled(plugin.id, enabled));
      setNotice(`${plugin.name} 已${enabled ? '启用' : '停用'}`);
    } catch (toggleError) {
      setError(formatError(toggleError));
    } finally {
      setPendingId(null);
    }
  }

  if (openPlugin) {
    return (
      <PluginDetail
        plugin={openPlugin}
        busy={pendingId === openPlugin.id}
        canToggle={canToggle}
        canSettings={canSettings}
        loading={loading}
        error={error}
        notice={notice}
        onBack={() => onSelectPlugin(null)}
        onRefresh={() => void load()}
        onToggleEnabled={(enabled) => void toggle(openPlugin, enabled)}
        onSaved={setDetails}
        onNewSession={onNewSession}
        onOpenPluginPage={onOpenPluginPage}
      />
    );
  }

  return (
    <PluginCatalog
      details={details}
      plugins={plugins}
      loading={loading}
      error={error}
      notice={notice}
      filter={filter}
      category={category}
      onCategoryChange={setCategory}
      canToggle={canToggle}
      busyId={pendingId}
      onFilterChange={setFilter}
      onOpen={onSelectPlugin}
      onRefresh={() => void load()}
      onToggle={(plugin, enabled) => void toggle(plugin, enabled)}
    />
  );
}

type PluginCategory = 'desktop' | 'configurable' | 'tools' | 'user';

export function pluginCategory(plugin: ConfigWebPlugin): PluginCategory {
  if (plugin.source === 'user') return 'user';
  if (plugin.desktopEntry || plugin.desktopPage || plugin.desktopPanel || plugin.desktopSessionMenu.length > 0)
    return 'desktop';
  if (plugin.settings.fields.length > 0 || plugin.llm || plugin.desktopChecks.length > 0 || plugin.actions.length > 0)
    return 'configurable';
  return 'tools';
}

const PLUGIN_CATEGORIES: { id: PluginCategory; label: string; description: string }[] = [
  { id: 'desktop', label: '桌面功能', description: '在桌面界面提供入口、面板或会话操作的官方插件' },
  { id: 'configurable', label: '可配置', description: '有设置、运行条件或操作的其他官方插件' },
  { id: 'tools', label: '其他工具', description: '为模型和运行时提供能力的其他官方插件' },
  { id: 'user', label: '用户插件', description: '安装在本地插件目录的插件' },
];

/** 目录页按能力与来源切换，避免一次展示全部插件。 */
function PluginCatalog({
  details,
  plugins,
  loading,
  error,
  notice,
  filter,
  category,
  canToggle,
  busyId,
  onFilterChange,
  onCategoryChange,
  onOpen,
  onRefresh,
  onToggle,
}: {
  details: ConfigWebPluginsDetails | null;
  plugins: ConfigWebPlugin[];
  loading: boolean;
  error: string | null;
  notice: string | null;
  filter: string;
  category: PluginCategory;
  canToggle: boolean;
  busyId: string | null;
  onFilterChange(value: string): void;
  onCategoryChange(value: PluginCategory): void;
  onOpen(id: string): void;
  onRefresh(): void;
  onToggle(plugin: ConfigWebPlugin, enabled: boolean): void;
}) {
  const RefreshIcon = appIcons.refresh;
  const SearchIcon = appIcons.search;
  const enabledCount = plugins.filter((plugin) => plugin.state === 'enabled').length;
  const matching = filterPlugins(plugins, filter);
  const selected = PLUGIN_CATEGORIES.find((item) => item.id === category)!;
  const categoryPlugins = plugins.filter((plugin) => pluginCategory(plugin) === category);
  const visible = matching.filter((plugin) => pluginCategory(plugin) === category);

  return (
    <PageFrame
      title="插件"
      description="官方插件随 Mica 分发，用户插件装在本地插件目录；点开一张卡片查看设置与运行条件"
      path={details?.root}
      actions={
        <div className="toolbar">
          {notice ? <span className="save-status">{notice}</span> : null}
          <Button icon={<RefreshIcon size={15} />} title="重新加载" onClick={onRefresh} loading={loading} />
        </div>
      }
    >
      {error ? <Alert message={error} /> : null}
      {loading && !details ? (
        <div className="page-loading">正在加载插件…</div>
      ) : (
        <div className="plugin-catalog">
          <div className="plugin-catalog-toolbar">
            <div className="plugin-catalog-summary">
              {plugins.length} 个插件 · {enabledCount} 个已启用
            </div>
            <label className="plugin-catalog-filter">
              <SearchIcon size={14} aria-hidden="true" />
              <input
                value={filter}
                type="search"
                aria-label="搜索插件"
                placeholder="搜索插件"
                onChange={(event) => onFilterChange(event.target.value)}
              />
            </label>
          </div>
          <div className="session-tabs plugin-catalog-tabs" aria-label="插件分类">
            {PLUGIN_CATEGORIES.map((item) => (
              <button
                key={item.id}
                type="button"
                className={`session-tab${category === item.id ? ' session-tab-active' : ''}`}
                aria-pressed={category === item.id}
                onClick={() => onCategoryChange(item.id)}
              >
                {item.label}{' '}
                <span className="plugin-tab-count">
                  {matching.filter((plugin) => pluginCategory(plugin) === item.id).length}
                </span>
              </button>
            ))}
          </div>
          <PluginSection
            title={selected.label}
            description={
              category === 'user' ? `装在 ${details?.root ?? '$MICA_HOME/plugins'} 下的插件目录` : selected.description
            }
            plugins={visible}
            total={categoryPlugins.length}
            emptyText={filter ? '此分类没有匹配的插件' : category === 'user' ? '还没有安装用户插件' : '此分类暂无插件'}
            hint={!filter && category === 'user' ? '把插件目录放进去后点右上角重新加载' : undefined}
            canToggle={canToggle}
            busyId={busyId}
            onOpen={onOpen}
            onToggle={onToggle}
          />
        </div>
      )}
    </PageFrame>
  );
}

function PluginSection({
  title,
  description,
  plugins,
  total,
  emptyText,
  hint,
  canToggle,
  busyId,
  onOpen,
  onToggle,
}: {
  title: string;
  description: string;
  plugins: ConfigWebPlugin[];
  total: number;
  emptyText: string;
  hint?: string;
  canToggle: boolean;
  busyId: string | null;
  onOpen(id: string): void;
  onToggle(plugin: ConfigWebPlugin, enabled: boolean): void;
}) {
  return (
    <section className="plugin-section">
      <header className="plugin-section-head">
        <div className="plugin-section-copy">
          <h2>
            {title}
            <span className="plugin-section-count">{plugins.length}</span>
          </h2>
          <p>{description}</p>
        </div>
      </header>
      {plugins.length === 0 ? (
        <div className="plugin-section-empty">
          {emptyText}
          {total > 0 ? null : hint ? <span>{hint}</span> : null}
        </div>
      ) : (
        <div className="plugin-grid">
          {plugins.map((plugin) => (
            <PluginCard
              key={plugin.id}
              plugin={plugin}
              canToggle={canToggle}
              busy={busyId === plugin.id}
              onOpen={() => onOpen(plugin.id)}
              onToggle={(enabled) => onToggle(plugin, enabled)}
            />
          ))}
        </div>
      )}
    </section>
  );
}

/**
 * 一张插件卡片：图标是它的身份，卡片本身就是入口。
 *
 * 启停开关是卡片的兄弟节点而不是子节点：按钮里不能再套一个按钮（`<label>` + `<input>`），
 * 浏览器会把它当成非法嵌套，键盘与点击行为都不再可靠。所以外壳自己画边框，里面是
 * 「打开详情」的按钮 + 右上角那枚开关。
 */
export function PluginCard({
  plugin,
  canToggle,
  busy,
  onOpen,
  onToggle,
}: {
  plugin: ConfigWebPlugin;
  canToggle: boolean;
  busy: boolean;
  onOpen(): void;
  onToggle(enabled: boolean): void;
}) {
  const status = pluginRunningStatus(plugin);
  const attention = plugin.state === 'enabled' ? plugin.attention : null;
  const enabled = plugin.state !== 'disabled';
  // 「运行出错」这种一句话说明不了问题的结论，悬停就能看到插件自己上报的那条。
  const statusTitle =
    plugin.health && plugin.health.level !== 'ok'
      ? [status.label, plugin.health.message, plugin.health.hint].filter(Boolean).join(' · ')
      : status.label;
  // 装配成功不写在卡片上：右上角那枚开关已经在说「它在用」，绿色一行只在确实有事要说
  // （停用、被跳过、加载失败、待配置、尚未加载）时才出现。
  const showStatus = status.tone !== 'green';
  const hasFooter = showStatus || plugin.settings.fields.length > 0 || plugin.desktopChecks.length > 0;
  return (
    <div
      className={`plugin-card${plugin.state === 'enabled' ? '' : ' is-inactive'}${attention ? ' has-attention' : ''}`}
    >
      <button
        type="button"
        className="plugin-card-open"
        title={attention ? `${plugin.name} · ${attention.text}` : `${plugin.name} · ${plugin.location}`}
        onClick={onOpen}
      >
        <span className="plugin-card-icon">
          <PluginIcon name={plugin.icon} size={18} />
          {attention ? <span className={`plugin-attention-dot is-${attention.tone}`} aria-hidden="true" /> : null}
        </span>
        <span className="plugin-card-body">
          <span className="plugin-card-head">
            <span className="plugin-card-name">{plugin.name}</span>
            <span className="plugin-card-version">v{plugin.version}</span>
          </span>
          <span className="plugin-card-description">{plugin.description || '这个插件没有写描述'}</span>
          {attention ? (
            <span className="plugin-card-attention">
              <span className="plugin-card-attention-text">{attention.text}</span>
            </span>
          ) : null}
          {hasFooter ? (
            <span className="plugin-card-foot">
              {showStatus ? (
                <span className={`plugin-card-status is-${status.tone}`} title={statusTitle}>
                  {status.label}
                </span>
              ) : null}
              {plugin.settings.fields.length > 0 ? (
                <span className="plugin-card-note">{plugin.settings.fields.length} 项设置</span>
              ) : null}
              {plugin.desktopChecks.length > 0 ? (
                <span className="plugin-card-note">{plugin.desktopChecks.length} 项运行条件</span>
              ) : null}
            </span>
          ) : null}
        </span>
      </button>
      {canToggle ? (
        <label
          className="plugin-card-toggle"
          title={enabled ? '停用后它的工具、命令与入口立刻撤下' : '启用后它的工具、命令与入口立刻恢复'}
        >
          <Switch
            checked={enabled}
            disabled={busy}
            label={`${enabled ? '停用' : '启用'}插件 ${plugin.name}`}
            onChange={onToggle}
          />
        </label>
      ) : null}
    </div>
  );
}

/** 详情页：自己的页头（图标 + 名字 + 启停），下面是设置 / 运行条件 / 信息三块。 */
export function PluginDetail({
  plugin,
  busy,
  canToggle,
  canSettings,
  loading,
  error,
  notice,
  onBack,
  onRefresh,
  onToggleEnabled,
  onSaved,
  onNewSession,
  onOpenPluginPage,
}: {
  plugin: ConfigWebPlugin;
  busy: boolean;
  canToggle: boolean;
  canSettings: boolean;
  loading: boolean;
  error: string | null;
  notice: string | null;
  onBack(): void;
  onRefresh(): void;
  onToggleEnabled(enabled: boolean): void;
  onSaved(next: ConfigWebPluginsDetails): void;
  onNewSession?(task: ConfigWebPluginNewSession): boolean | void;
  onOpenPluginPage?(pluginId: string): boolean | void | Promise<boolean | void>;
}) {
  const BackIcon = appIcons.chevronLeft;
  const RefreshIcon = appIcons.refresh;
  const enabled = plugin.state !== 'disabled';
  // 整页的开与不开由宿主说了算（模块只在随包插件里），所以打不开时要说一句。
  const [pageError, setPageError] = useState<string | null>(null);
  const pageTitle = plugin.desktopPage?.title || plugin.name;
  async function openPage() {
    setPageError(null);
    const opened = await onOpenPluginPage?.(plugin.id);
    if (opened === false) setPageError(`打不开「${pageTitle}」：整页只对随包插件可用`);
  }
  // 设置草稿提到详情这一层：动作按钮（包括 attention 上那一个）发出去的值必须是
  // 用户刚在下面那半页里改的，不能是磁盘上那份旧的。
  const draft = usePluginSettingsDraft(plugin, onSaved);
  // 没有任何「要动的东西」时不摆两列：右边信息栏贴着一条空的左栏，读起来像内容没加载出来。
  const hasConfigurable = plugin.desktopChecks.length > 0 || plugin.settings.fields.length > 0;
  return (
    <div className="plugin-detail">
      <header className="plugin-detail-bar">
        <button type="button" className="plugin-back" onClick={onBack}>
          <BackIcon size={14} aria-hidden="true" />
          <span>插件</span>
        </button>
        <span className="plugin-detail-bar-title" title={plugin.location}>
          {plugin.location}
        </span>
        <div className="plugin-detail-bar-actions">
          {notice ? <span className="save-status">{notice}</span> : null}
          <Button
            icon={<RefreshIcon size={15} />}
            title="重新加载"
            ariaLabel="重新加载插件"
            loading={loading}
            onClick={onRefresh}
          />
        </div>
      </header>

      <div className="plugin-detail-scroll">
        <header className="plugin-hero">
          <span className="plugin-hero-icon">
            <PluginIcon name={plugin.icon} size={22} strokeWidth={1.6} />
          </span>
          <div className="plugin-hero-copy">
            <h1>{plugin.name}</h1>
            <p>
              v{plugin.version} · {pluginSourceLabel(plugin.source)}
              {plugin.author ? ` · ${plugin.author}` : ''}
            </p>
          </div>
          <div className="plugin-hero-actions">
            {/* 插件自己的整页（清单 `desktop.page`）：有些插件没有侧栏入口，页面入口就
                只剩这里——它自己的设置页里。 */}
            {plugin.desktopPage && onOpenPluginPage ? (
              <Button size="compact" title={`打开「${pageTitle}」页面`} onClick={() => void openPage()}>
                {`打开${pageTitle}`}
              </Button>
            ) : null}
            <label
              className="plugin-toggle"
              title={
                !canToggle
                  ? '这个宿主不能启停插件'
                  : enabled
                    ? '停用后它的工具、命令与入口立刻撤下'
                    : '启用后它的工具、命令与入口立刻恢复'
              }
            >
              <Switch
                checked={enabled}
                disabled={!canToggle || busy}
                label={`${enabled ? '停用' : '启用'}插件 ${plugin.name}`}
                onChange={onToggleEnabled}
              />
            </label>
          </div>
        </header>

        {error ? <Alert message={error} /> : null}
        {pageError ? <Alert message={pageError} /> : null}
        {plugin.description ? <p className="plugin-description">{plugin.description}</p> : null}
        {plugin.error ? <Alert message={plugin.error} /> : null}
        {/* 插件上报的「点一下就能变好」：提示点已经把人引到这里，这里给的是那个按钮。
            一直挂着不卸载：动作成功后插件往往会撤掉 attention，结果那句话还得留在原地。 */}
        {plugin.state === 'enabled' && (plugin.attention || plugin.actions.length > 0) ? (
          <PluginAttentionBar plugin={plugin} values={draft.values} onDone={onSaved} onNewSession={onNewSession} />
        ) : null}
        {plugin.health && plugin.health.level !== 'ok' ? (
          <div className={`plugin-health is-${plugin.health.level}`}>
            <span className="plugin-health-title">
              {pluginHealthLabel(plugin)}
              {plugin.health.at ? ` · ${formatHealthTime(plugin.health.at)}` : ''}
            </span>
            <span>{plugin.health.message}</span>
            {plugin.health.hint ? <span className="plugin-health-note">{plugin.health.hint}</span> : null}
          </div>
        ) : null}

        {hasConfigurable ? (
          <div className="plugin-columns">
            <div className="plugin-column">
              <PluginStatusGroup plugin={plugin} />
              {plugin.desktopChecks.length > 0 ? <PluginChecksGroup plugin={plugin} /> : null}
              {plugin.settings.fields.length > 0 ? (
                <PluginSettingsForm plugin={plugin} draft={draft} canSave={canSettings} />
              ) : null}
              {plugin.actions.length > 0 ? (
                <PluginActionsGroup
                  plugin={plugin}
                  values={draft.values}
                  onDone={onSaved}
                  onNewSession={onNewSession}
                />
              ) : null}
            </div>
            <aside className="plugin-column">
              <PluginInfoGroup plugin={plugin} />
            </aside>
          </div>
        ) : (
          // 没有可配置项：一行说明接信息表，单列往下排，不留半页空白
          <div className="plugin-columns is-solo">
            <div className="plugin-solo">
              <PluginStatusGroup plugin={plugin} />
              {plugin.actions.length > 0 ? (
                <PluginActionsGroup
                  plugin={plugin}
                  values={draft.values}
                  onDone={onSaved}
                  onNewSession={onNewSession}
                />
              ) : null}
              <p className="plugin-note">这个插件没有可配置项。</p>
              <PluginInfoGroup plugin={plugin} />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/** 动作把下一步交给一个新会话之后，页面实际发生了什么。 */
type NewSessionOutcome = 'launched' | 'unsupported' | 'refused' | null;

/**
 * 动作把下一步交给一个新会话时，先转给宿主：开页签、挂角色、把提示词放进输入框都是页面的事。
 *
 * 宿主接不了（浏览器宿主没有会话；桌面端此刻没有工作目录）必须能区分出来——按钮点下去
 * 看起来什么都没发生，就是「失败被吞掉」的样子。
 */
function dispatchNewSession(
  result: ConfigWebPluginActionResult,
  onNewSession?: (task: ConfigWebPluginNewSession) => boolean | void,
): NewSessionOutcome {
  if (!result?.newSession) return null;
  if (!onNewSession) return 'unsupported';
  return onNewSession(result.newSession) === false ? 'refused' : 'launched';
}

function newSessionHint(outcome: NewSessionOutcome): string {
  if (outcome === 'unsupported') return '这一步要开一个新会话：在桌面端里点它才会跳过去。';
  if (outcome === 'refused') return '开不了新会话：先在桌面端里给对话选一个工作目录。';
  return '';
}

/**
 * 右侧的信息栏：只回答「它是谁、装没装上、在磁盘哪」，不列插件里的文件。
 *
 * 每行都单行省略（完整值在 `title` 里）：这里是排查用的索引，不是文件浏览器，
 * 一列换行的路径会把这张表读成两栏错位。
 */
/**
 * 运行状态：清单声明「有哪几行」，值由插件自己写进 `plugin-data/<id>/data.json`。
 *
 * 插件没上报过的键显示占位而不是隐藏——那一行本来就在声明里，消失会让人以为
 * 声明写错了。
 */
/**
 * 配置页动作（清单 `actions`）：按钮由清单声明，点一下由插件自己执行。
 *
 * 结果就写在这块里——注册这类动作的产出是一条链接，让它出现在插件配置里，
 * 比跳到对话再回来更自然。动作通常会顺手改设置或状态，所以成功后重读一次详情。
 */
export function PluginActionsGroup({
  plugin,
  values,
  onDone,
  onNewSession,
}: {
  plugin: ConfigWebPlugin;
  values: Record<string, string>;
  onDone: (next: ConfigWebPluginsDetails) => void;
  onNewSession?(task: ConfigWebPluginNewSession): boolean | void;
}) {
  const [running, setRunning] = useState<string | null>(null);
  const [results, setResults] = useState<Record<string, ConfigWebPluginActionResult>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [hints, setHints] = useState<Record<string, string>>({});

  async function run(action: ConfigWebPluginAction) {
    setRunning(action.key);
    setErrors((prev) => ({ ...prev, [action.key]: '' }));
    try {
      const result = await runPluginAction(plugin.id, action.key, values);
      setResults((prev) => ({ ...prev, [action.key]: result }));
      const outcome = dispatchNewSession(result, onNewSession);
      setHints((prev) => ({ ...prev, [action.key]: newSessionHint(outcome) }));
      // 已经跳到新会话了：这个页面正在关掉，不再为它刷新一次详情。
      if (outcome === 'launched') return;
      onDone(await readPluginsDetails());
    } catch (error) {
      setErrors((prev) => ({
        ...prev,
        [action.key]: error instanceof Error ? error.message : String(error),
      }));
    } finally {
      setRunning(null);
    }
  }

  return (
    <SettingsGroup title="操作">
      {plugin.actions.map((action) => {
        const result = results[action.key];
        const error = errors[action.key];
        const hint = hints[action.key];
        // 一行一件事：左边一句话说清它做什么，右边按钮执行。说明只留一行、放不下的进 tooltip，
        // 结果与错误另起一行铺满（链接经常比半页还长）——不要把一个按钮讲成一整段话。
        const note = action.description ?? '';
        return (
          <div className="plugin-action-row" key={action.key}>
            <span className="plugin-action-note" title={note || undefined}>
              {note}
            </span>
            <Button
              variant={action.tone === 'primary' ? 'primary' : action.tone === 'danger' ? 'danger' : 'default'}
              loading={running === action.key}
              disabled={running !== null && running !== action.key}
              title={note || undefined}
              onClick={() => void run(action)}
            >
              {action.label}
            </Button>
            {error || result ? (
              <div className="plugin-action-outcome">
                {error ? <span className="plugin-action-error">{error}</span> : null}
                {result ? (
                  <span className="plugin-action-result">
                    {result.message}
                    {hint ? ` ${hint}` : ''}
                    {result.link ? (
                      <>
                        {' '}
                        <a href={result.link} target="_blank" rel="noreferrer">
                          {result.link}
                        </a>
                      </>
                    ) : null}
                  </span>
                ) : null}
              </div>
            ) : null}
          </div>
        );
      })}
    </SettingsGroup>
  );
}

/**
 * 「有一件事等人点一下」的那一条。
 *
 * 文案与动作都来自插件自己的数据（`attention`），页面只负责画与转交——不认识任何具体插件。
 * 动作就地执行，结果写在这一条里，成功后重读一次详情：插件通常会顺手把自己上报的提示撤掉。
 */
function PluginAttentionBar({
  plugin,
  values,
  onDone,
  onNewSession,
}: {
  plugin: ConfigWebPlugin;
  values: Record<string, string>;
  onDone: (next: ConfigWebPluginsDetails) => void;
  onNewSession?(task: ConfigWebPluginNewSession): boolean | void;
}) {
  const attention = plugin.attention;
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<ConfigWebPluginActionResult | null>(null);
  const [hint, setHint] = useState('');
  const [error, setError] = useState<string | null>(null);
  // 动作成功后插件通常会撤掉自己上报的 attention：那正是结果最该被看见的时刻，
  // 不能让整块提示连同结果一起消失。
  if (!attention && !result && !error) return null;
  const action = attention?.action ? (plugin.actions.find((item) => item.key === attention.action) ?? null) : null;

  async function run() {
    if (!action) return;
    setRunning(true);
    setError(null);
    setHint('');
    try {
      const next = await runPluginAction(plugin.id, action.key, values);
      const outcome = dispatchNewSession(next, onNewSession);
      // 已经跳到新会话了：这个页面正在关掉，不再为它刷新一次详情。
      if (outcome === 'launched') return;
      setResult(next);
      setHint(newSessionHint(outcome));
      onDone(await readPluginsDetails());
    } catch (runError) {
      setError(formatError(runError));
    } finally {
      setRunning(false);
    }
  }

  return (
    <div className={`plugin-attention is-${attention?.tone ?? 'ok'}`}>
      <span className="plugin-attention-body">
        {attention ? <span className="plugin-attention-text">{attention.text}</span> : null}
        {error ? <span className="plugin-attention-note">{error}</span> : null}
        {result ? (
          <span className="plugin-attention-note">
            {result.message}
            {hint ? ` ${hint}` : ''}
            {result.link ? (
              <>
                {' '}
                <a href={result.link} target="_blank" rel="noreferrer">
                  {result.link}
                </a>
              </>
            ) : null}
          </span>
        ) : null}
      </span>
      {action ? (
        <Button variant="primary" loading={running} onClick={() => void run()}>
          {action.label}
        </Button>
      ) : null}
    </div>
  );
}

function PluginStatusGroup({ plugin }: { plugin: ConfigWebPlugin }) {
  if (plugin.status.length === 0) return null;
  return (
    <SettingsGroup title="运行状态">
      <dl className="plugin-meta">
        {plugin.status.map((row) => (
          <div className="plugin-meta-row" key={row.key}>
            <dt>{row.label}</dt>
            <dd
              className={row.value ? (row.tone ? `is-${row.tone}` : undefined) : undefined}
              title={row.value ?? '插件还没上报'}
            >
              {row.value ? (
                row.type === 'link' ? (
                  <a href={row.value} target="_blank" rel="noreferrer">
                    {row.value}
                  </a>
                ) : (
                  row.value
                )
              ) : (
                <span className="plugin-meta-empty">尚未上报</span>
              )}
            </dd>
          </div>
        ))}
      </dl>
    </SettingsGroup>
  );
}

function PluginInfoGroup({ plugin }: { plugin: ConfigWebPlugin }) {
  const rows: { label: string; value: string; mono?: boolean; title?: string; pathLink?: boolean }[] = [
    { label: '标识', value: plugin.id, mono: true },
    {
      label: '加载',
      // 与卡片脚注同一份结论：停用时不能还显示上一次装配留下的「已加载」。
      value: pluginRunningStatus(plugin).label,
      title: plugin.skipReason ?? plugin.loadStatus,
    },
    ...(plugin.skipReason ? [{ label: '跳过原因', value: plugin.skipReason, title: plugin.skipReason }] : []),
    { label: '目录', value: plugin.location, mono: true },
    // 日志是可以直接看的文件：点开选「在 Finder 中打开」或「在 Mica 中打开」。
    // 目录这一行不是——官方插件的目录是仓库里的相对路径，装好的应用里根本没有。
    { label: '日志', value: plugin.logFile, mono: true, pathLink: true },
  ];
  return (
    <SettingsGroup title="信息">
      <dl className="plugin-meta">
        {rows.map((row) => (
          <div className="plugin-meta-row" key={row.label}>
            <dt>{row.label}</dt>
            <dd className={row.mono ? 'is-mono' : undefined} title={row.title ?? row.value}>
              {row.pathLink && row.value ? <PathLink path={row.value} /> : row.value}
            </dd>
          </div>
        ))}
      </dl>
    </SettingsGroup>
  );
}

/** 「已加载 · TUI」：结论与写它的宿主一起读，跨宿主的跳过才不会被当成故障。 */
function loadStatusText(plugin: ConfigWebPlugin): string {
  const status = pluginLoadStatusLabel(plugin.loadStatus);
  const host = pluginHostLabel(plugin.loadHost);
  return plugin.loadStatus && host ? `${status} · ${host}` : status;
}

/**
 * 插件的运行条件（清单 `desktop.checks`）：权限开没开、依赖装没装，以及「去哪里开」。
 *
 * 这一节完全由清单声明驱动，页面不认识任何具体插件。状态只有桌面宿主答得上来（TCC 权限
 * 属于有 app 身份的那个进程），浏览器宿主会交回 `supported: false`——那就说明白「需要在
 * 桌面应用里查看」，而不是假装一切正常。
 *
 * 权限是在系统设置里改的，改完这里不知道：重新获得焦点、切回本页或点刷新时再问一次。
 */
function PluginChecksGroup({ plugin }: { plugin: ConfigWebPlugin }) {
  const [statuses, setStatuses] = useState<Record<string, ConfigWebDesktopCheckStatus>>({});
  const [supported, setSupported] = useState(true);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [opening, setOpening] = useState<string | null>(null);
  const inFlight = useRef(false);
  const RefreshIcon = appIcons.refresh;

  const refresh = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setLoading(true);
    try {
      const result = await readDesktopChecks();
      const next: Record<string, ConfigWebDesktopCheckStatus> = {};
      for (const check of result.checks) next[check.id] = check;
      setStatuses(next);
      setSupported(result.supported);
      setError(null);
    } catch (readError) {
      setError(formatError(readError));
    } finally {
      inFlight.current = false;
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh, plugin.id]);

  // 用户去系统设置里开权限、再切回来：窗口聚焦与标签页重新可见都是回来的信号。
  useEffect(() => {
    const onFocus = () => void refresh();
    const onVisible = () => {
      if (document.visibilityState === 'visible') void refresh();
    };
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [refresh]);

  async function openSettings(pane: string) {
    setOpening(pane);
    try {
      const result = await openDesktopSettings(pane);
      // 打不开要说出来：点完毫无反应比报错更让人困惑
      setError(result.ok ? null : result.error || '打不开系统设置');
    } finally {
      setOpening(null);
    }
  }

  return (
    <SettingsGroup
      title="运行条件"
      description="这些条件由运行 Mica 的应用持有，缺一项时插件会静默失效"
      actions={
        <Button
          icon={<RefreshIcon size={15} />}
          title="重新检查"
          ariaLabel="重新检查运行条件"
          loading={loading}
          onClick={() => void refresh()}
        />
      }
    >
      {error ? <Alert message={error} /> : null}
      {!supported ? (
        <div className="plugin-health">
          <span className="plugin-health-note">需要在桌面应用的设置页里查看这些条件。</span>
        </div>
      ) : null}
      {plugin.desktopChecks.map((check) => {
        const status = statuses[check.id]?.status ?? 'unknown';
        const detail = statuses[check.id]?.detail ?? '';
        const canOpen = Boolean(check.pane) && status !== 'granted';
        return (
          <SettingRow key={check.id} label={check.label} hint={check.description}>
            <div className="plugin-check">
              <Tag tone={DESKTOP_CHECK_TONE[status]} dot>
                {desktopCheckStatusLabel(status)}
              </Tag>
              {detail ? <span className="plugin-check-detail">{detail}</span> : null}
              {canOpen && supported ? (
                <Button
                  variant="ghost"
                  title={`打开${check.label}的系统设置`}
                  loading={opening === check.pane}
                  onClick={() => void openSettings(check.pane as string)}
                >
                  打开设置
                </Button>
              ) : null}
            </div>
          </SettingRow>
        );
      })}
    </SettingsGroup>
  );
}

/** 两份设置值是否完全一致（键集合与每个值）。 */
function sameValues(a: Record<string, string>, b: Record<string, string>): boolean {
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  return keys.every((key) => a[key] === b[key]);
}

/**
 * 插件设置表单。
 *
 * 字段完全来自插件清单的 `settings` 声明，页面不认识任何具体插件——加一个插件不需要改这里。
 * 没有保存按钮：改动停下就写盘（与其他配置页同一套 `useAutoSave`），插件的下一次读取就会
 * 拿到新值，所以不需要「重开会话」。
 */
type PluginSettingsDraft = {
  values: Record<string, string>;
  fieldErrors: Record<string, string>;
  autosave: ReturnType<typeof useAutoSave<Record<string, string>, ConfigWebPluginsDetails>>;
  update(key: string, value: string): void;
};

/**
 * 插件设置草稿：改动停下就写盘，返回值既给设置表单，也给同一页里的动作按钮。
 */
function usePluginSettingsDraft(
  plugin: ConfigWebPlugin,
  onSaved: (next: ConfigWebPluginsDetails) => void,
): PluginSettingsDraft {
  const [values, setValues] = useState<Record<string, string>>(plugin.settings.values);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  // 上一次从清单同步进来的那份值。草稿与它一样，说明用户没在下手，可以整份跟随刷新；
  // 不一样就是正在打（或刚打完、还在 400ms 防抖窗口里）的字——拿磁盘值顶掉它，
  // 之后每次输入都会基于重置后的旧值重建，前面那几个字符就静默丢了。
  const syncedRef = useRef(plugin.settings.values);

  useEffect(() => {
    const previous = syncedRef.current;
    syncedRef.current = plugin.settings.values;
    setValues((current) => (sameValues(current, previous) ? plugin.settings.values : current));
  }, [plugin.id, plugin.settings.values]);

  const autosave = useAutoSave<Record<string, string>, ConfigWebPluginsDetails>({
    save: (next) => writePluginSettings(plugin.id, next),
    onSaved: (result) => {
      // 保存成功意味着整组值通过了校验：清掉逐字段提示，页面与磁盘从此一致。
      setFieldErrors({});
      onSaved(result);
    },
    onError: (message) => setFieldErrors(parseSettingIssues(message)),
  });

  function update(key: string, value: string) {
    const next = { ...values, [key]: value };
    setValues(next);
    autosave.schedule(next);
  }

  return { values, fieldErrors, autosave, update };
}

function PluginSettingsForm({
  plugin,
  draft,
  canSave,
}: {
  plugin: ConfigWebPlugin;
  draft: PluginSettingsDraft;
  canSave: boolean;
}) {
  const { values, fieldErrors, autosave, update } = draft;

  return (
    <>
      <SettingsGroup
        title="设置"
        description="改动停下就写盘，插件的下一次读取即生效"
        actions={<SaveStatus saving={autosave.saving} saved={autosave.status === 'saved'} />}
      >
        {autosave.error && Object.keys(fieldErrors).length === 0 ? <Alert message={autosave.error} /> : null}
        {plugin.settings.issues.length > 0 ? (
          <div className="plugin-health is-warn">
            <span className="plugin-health-title">已保存的配置不完整，插件因此不会生效</span>
            {plugin.settings.issues.map((issue) => (
              <span key={issue.key}>
                {issue.label}：{issue.message}
              </span>
            ))}
          </div>
        ) : null}
        {/* 模型接口的那几项由下面的 LlmSettingsSection 统一渲染（带测试按钮）。 */}
        {plugin.settings.fields
          .filter((field) => field.group !== 'llm')
          .map((field) => (
            <SettingRow
              key={field.key}
              htmlFor={`plugin-setting-${field.key}`}
              label={
                <>
                  {field.label}
                  {field.required ? <span className="plugin-setting-required">必填</span> : null}
                  {field.perSession ? <span className="plugin-setting-session">可按会话覆盖</span> : null}
                </>
              }
              hint={field.description}
              error={fieldErrors[field.key]}
              wide={field.type === 'textarea'}
            >
              <PluginSettingInput
                field={field}
                value={values[field.key] ?? ''}
                disabled={!canSave}
                invalid={Boolean(fieldErrors[field.key])}
                onChange={(next) => update(field.key, next)}
              />
            </SettingRow>
          ))}
      </SettingsGroup>
      <LlmSettingsSection
        llm={plugin.llm}
        fields={plugin.settings.fields}
        values={values}
        errors={Object.entries(fieldErrors).map(([key, message]) => ({
          key,
          label: plugin.settings.fields.find((field) => field.key === key)?.label ?? key,
          message,
        }))}
        onChange={update}
        onTest={(next) => testPluginLlm(plugin.id, next)}
        disabled={!canSave}
      />
    </>
  );
}

function filterPlugins(plugins: ConfigWebPlugin[], filter: string): ConfigWebPlugin[] {
  const query = filter.trim().toLocaleLowerCase();
  if (!query) return plugins;
  return plugins.filter((plugin) =>
    `${plugin.name} ${plugin.id} ${plugin.description ?? ''}`.toLocaleLowerCase().includes(query),
  );
}

/** 脚注与信息表共用的结论文案色。 */
export type PluginRunningTone = 'default' | 'green' | 'red' | 'blue';

/**
 * 运行结论：上一次宿主把它装配成了什么样。
 *
 * 与开关是两件事——开关说「启用还是停用」，这里说「装配成功没有」。没被任何宿主装配过就
 * 如实说「尚未加载」：官方插件确实随包分发，但「装上了」不等于「这个宿主把它装配成功了」。
 *
 * 卡片只在结论不是「已加载」时上屏（详情页信息表照常显示）：正常加载时它与开关说的是
 * 同一件事，重复一遍只是噪声。
 *
 * 「加载失败」只属于装配这一步；插件自己上报的 `error` 是**装配成功之后的运行故障**
 * （接口连不上、脚本缺失），两者混成一句话会让开关亮着、脚注却写着「加载失败」。
 */
export function pluginRunningStatus(plugin: ConfigWebPlugin): { label: string; tone: PluginRunningTone } {
  if (plugin.state !== 'enabled') {
    return { label: pluginStateLabel(plugin.state), tone: plugin.state === 'failed' ? 'red' : 'default' };
  }
  if (plugin.loadStatus === 'failed') return { label: '加载失败', tone: 'red' };
  if (plugin.health?.level === 'error') return { label: '运行出错', tone: 'red' };
  if (plugin.health?.level === 'warn') return { label: '待配置', tone: 'blue' };
  // 装配结论连宿主一起读：同一个插件在 TUI 里被跳过、在会话宿主里正常运行都很正常。
  if (plugin.loadStatus === 'loaded' || plugin.loadStatus === 'skipped') {
    return { label: loadStatusText(plugin), tone: plugin.loadStatus === 'loaded' ? 'green' : 'default' };
  }
  return { label: pluginLoadStatusLabel(plugin.loadStatus), tone: 'default' };
}

function pluginHealthLabel(plugin: ConfigWebPlugin): string {
  if (plugin.state === 'failed') return '加载失败';
  if (plugin.health?.level === 'error') return '运行出错';
  if (plugin.health?.level === 'warn') return '待配置';
  return plugin.state === 'enabled' ? '正常' : '已停用';
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 从保存失败的文案里还原逐字段错误。
 *
 * 校验错误的格式由 `PluginSettingsValidationError` 固定：首行是摘要，之后每行一条
 * `key: 原因`。传输层只会把错误压成字符串，页面据此把提示放回对应字段。
 */
function parseSettingIssues(message: string): Record<string, string> {
  const errors: Record<string, string> = {};
  for (const line of message.split('\n').slice(1)) {
    const match = /^([A-Za-z][A-Za-z0-9_]*):\s*(.+)$/.exec(line.trim());
    if (match) errors[match[1]] = match[2];
  }
  return errors;
}

function formatHealthTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString();
}
