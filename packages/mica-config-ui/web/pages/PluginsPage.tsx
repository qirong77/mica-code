import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { PageFrame } from '../components/PageFrame.js';
import { PluginSettingInput } from '../components/PluginSettingInput.js';
import { Alert, Button, SaveStatus, SettingRow, SettingsGroup, Switch, Tag } from '../components/Ui.js';
import { LlmSettingsSection } from '../components/LlmSettingsSection.js';
import { PluginIcon } from '../pluginIcons.js';
import {
  openDesktopSettings,
  readDesktopChecks,
  readPluginsDetails,
  setPluginEnabled,
  supportsPluginSettings,
  supportsPluginToggle,
  writePluginSettings,
} from '../api.js';
import type { ConfigWebDesktopCheckStatus, ConfigWebPlugin, ConfigWebPluginsDetails } from '../../src/shared/types.js';
import { appIcons } from '../icons.js';
import { desktopCheckStatusLabel, pluginLoadStatusLabel, pluginSourceLabel, pluginStateLabel } from '../labels.js';
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
 * 启停只写本地状态文件，插件在启动阶段才注册，因此改完要重开会话才生效——页面提示这一点，
 * 而不是假装立刻生效。设置则不同：写盘后插件的下一次读取就拿到新值，不需要重开会话。
 *
 * 当前打开哪个插件由宿主（`pluginId`）决定：桌面端插件菜单直接落在某个插件的详情上，
 * 侧栏再点一次 Plugins 回到目录。返回按钮同样只回到目录，不回到上一个设置页——插件页是
 * 从哪里打开的，不影响它自己的层级。
 */
export function PluginsPage({
  pluginId = null,
  onSelectPlugin = () => {},
}: {
  pluginId?: string | null;
  onSelectPlugin?(pluginId: string | null): void;
} = {}) {
  const [details, setDetails] = useState<ConfigWebPluginsDetails | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
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
      setNotice(`${plugin.name} 已${enabled ? '启用' : '停用'}，重开会话后生效`);
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
      onFilterChange={setFilter}
      onOpen={onSelectPlugin}
      onRefresh={() => void load()}
    />
  );
}

/** 目录页：按来源分组的卡片网格，一眼看全「装了哪些、谁不健康」。 */
function PluginCatalog({
  details,
  plugins,
  loading,
  error,
  notice,
  filter,
  onFilterChange,
  onOpen,
  onRefresh,
}: {
  details: ConfigWebPluginsDetails | null;
  plugins: ConfigWebPlugin[];
  loading: boolean;
  error: string | null;
  notice: string | null;
  filter: string;
  onFilterChange(value: string): void;
  onOpen(id: string): void;
  onRefresh(): void;
}) {
  const RefreshIcon = appIcons.refresh;
  const SearchIcon = appIcons.search;
  const official = plugins.filter((plugin) => plugin.source === 'official');
  const user = plugins.filter((plugin) => plugin.source === 'user');
  const enabledCount = plugins.filter((plugin) => plugin.state === 'enabled').length;
  const visibleOfficial = useMemo(() => filterPlugins(official, filter), [official, filter]);
  const visibleUser = useMemo(() => filterPlugins(user, filter), [user, filter]);

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
          <PluginSection
            title="官方插件"
            description="随 Mica 分发，只能启用或停用"
            plugins={visibleOfficial}
            total={official.length}
            emptyText="没有匹配的官方插件"
            onOpen={onOpen}
          />
          <PluginSection
            title="用户插件"
            description={`装在 ${details?.root ?? '$MICA_HOME/plugins'} 下的插件目录`}
            plugins={visibleUser}
            total={user.length}
            emptyText={filter ? '没有匹配的用户插件' : '还没有安装用户插件'}
            hint={filter ? undefined : '把插件目录放进去后点右上角重新加载'}
            onOpen={onOpen}
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
  onOpen,
}: {
  title: string;
  description: string;
  plugins: ConfigWebPlugin[];
  total: number;
  emptyText: string;
  hint?: string;
  onOpen(id: string): void;
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
            <PluginCard key={plugin.id} plugin={plugin} onOpen={() => onOpen(plugin.id)} />
          ))}
        </div>
      )}
    </section>
  );
}

/** 一张插件卡片：图标是它的身份，卡片本身就是入口。 */
function PluginCard({ plugin, onOpen }: { plugin: ConfigWebPlugin; onOpen(): void }) {
  const status = pluginStatus(plugin);
  return (
    <button
      type="button"
      className={`plugin-card${plugin.state === 'enabled' ? '' : ' is-inactive'}`}
      title={`${plugin.name} · ${plugin.location}`}
      onClick={onOpen}
    >
      <span className="plugin-card-icon">
        <PluginIcon name={plugin.icon} size={18} />
      </span>
      <span className="plugin-card-body">
        <span className="plugin-card-head">
          <span className="plugin-card-name">{plugin.name}</span>
          <span className="plugin-card-version">v{plugin.version}</span>
        </span>
        <span className="plugin-card-description">{plugin.description || '这个插件没有写描述'}</span>
        <span className="plugin-card-foot">
          <Tag tone={status.tone} dot>
            {status.label}
          </Tag>
          {plugin.settings.fields.length > 0 ? (
            <span className="plugin-card-note">{plugin.settings.fields.length} 项设置</span>
          ) : null}
          {plugin.desktopChecks.length > 0 ? (
            <span className="plugin-card-note">{plugin.desktopChecks.length} 项运行条件</span>
          ) : null}
        </span>
      </span>
    </button>
  );
}

/** 详情页：自己的页头（图标 + 名字 + 启停），下面是设置 / 运行条件 / 信息三块。 */
function PluginDetail({
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
}) {
  const BackIcon = appIcons.chevronLeft;
  const RefreshIcon = appIcons.refresh;
  const enabled = plugin.state !== 'disabled';
  const status = pluginStatus(plugin);
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
            <Tag tone={status.tone} dot>
              {status.label}
            </Tag>
            <label className="plugin-toggle" title="停用后它的工具、命令与钩子都不会注册；重开会话生效">
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
        {plugin.description ? <p className="plugin-description">{plugin.description}</p> : null}
        {plugin.error ? <Alert message={plugin.error} /> : null}
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
                <PluginSettingsForm plugin={plugin} canSave={canSettings} onSaved={onSaved} />
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
              <p className="plugin-note">这个插件没有可配置项。</p>
              <PluginInfoGroup plugin={plugin} />
            </div>
          </div>
        )}
      </div>
    </div>
  );
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
  const rows: { label: string; value: string; mono?: boolean; title?: string }[] = [
    { label: '标识', value: plugin.id, mono: true },
    {
      label: '加载',
      value: pluginLoadStatusLabel(plugin.loadStatus ?? (plugin.source === 'official' ? 'loaded' : 'unknown')),
    },
    { label: '目录', value: plugin.location, mono: true },
    { label: '日志', value: plugin.logFile, mono: true },
  ];
  return (
    <SettingsGroup title="信息">
      <dl className="plugin-meta">
        {rows.map((row) => (
          <div className="plugin-meta-row" key={row.label}>
            <dt>{row.label}</dt>
            <dd className={row.mono ? 'is-mono' : undefined} title={row.title ?? row.value}>
              {row.value}
            </dd>
          </div>
        ))}
      </dl>
    </SettingsGroup>
  );
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

/**
 * 插件设置表单。
 *
 * 字段完全来自插件清单的 `settings` 声明，页面不认识任何具体插件——加一个插件不需要改这里。
 * 没有保存按钮：改动停下就写盘（与其他配置页同一套 `useAutoSave`），插件的下一次读取就会
 * 拿到新值，所以不需要「重开会话」。
 */
function PluginSettingsForm({
  plugin,
  canSave,
  onSaved,
}: {
  plugin: ConfigWebPlugin;
  canSave: boolean;
  onSaved(next: ConfigWebPluginsDetails): void;
}) {
  const [values, setValues] = useState<Record<string, string>>(plugin.settings.values);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  // 换插件、或者外部保存把值改回来时重新对齐：表单不能拿着上一个插件的草稿。
  useEffect(() => {
    setValues(plugin.settings.values);
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
        plugin={plugin}
        values={values}
        errors={Object.entries(fieldErrors).map(([key, message]) => ({
          key,
          label: plugin.settings.fields.find((field) => field.key === key)?.label ?? key,
          message,
        }))}
        onChange={update}
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

/** 卡片与详情共用的状态投影：异常优先于启停，因为「启用了但坏了」才是最需要看见的。 */
function pluginStatus(plugin: ConfigWebPlugin): { label: string; tone: 'default' | 'green' | 'red' | 'blue' } {
  if (plugin.state === 'failed' || plugin.health?.level === 'error') return { label: '出错', tone: 'red' };
  if (plugin.health?.level === 'warn') return { label: '待配置', tone: 'blue' };
  if (plugin.state === 'enabled') return { label: '已启用', tone: 'green' };
  return { label: pluginStateLabel(plugin.state), tone: 'default' };
}

function pluginHealthLabel(plugin: ConfigWebPlugin): string {
  if (plugin.state === 'failed') return '加载失败';
  if (plugin.health?.level === 'error') return '出错';
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
