import { useEffect, useMemo, useState } from 'react';
import { PageFrame } from '../components/PageFrame.js';
import { Alert, Button, SaveStatus, SettingRow, SettingsGroup, SplitView, Switch } from '../components/Ui.js';
import {
  readPluginsDetails,
  setPluginEnabled,
  supportsPluginSettings,
  supportsPluginToggle,
  writePluginSettings,
} from '../api.js';
import type { ConfigWebPlugin, ConfigWebPluginSetting, ConfigWebPluginsDetails } from '../../src/shared/types.js';
import { appIcons } from '../icons.js';
import { pluginLoadStatusLabel, pluginSourceLabel, pluginStateLabel } from '../labels.js';
import { useAutoSave } from '../useAutoSave.js';

/**
 * 插件页：左边列出插件，右边看选中的那一个。
 *
 * 两种插件含义不同，页面上必须说清楚：
 * - 官方插件随产品分发（源码在仓库 `plugins/`），永远「已安装」，只能启用 / 停用；
 * - 用户插件是 `$MICA_HOME/plugins` 下的插件目录，装没装、能不能加载由磁盘决定。
 *
 * 启停只写本地状态文件，插件在启动阶段才注册，因此改完要重开会话才生效——页面提示这一点，
 * 而不是假装立刻生效。设置则不同：写盘后插件的下一次读取就拿到新值，不需要重开会话。
 */
export function PluginsPage() {
  const [details, setDetails] = useState<ConfigWebPluginsDetails | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  const [notice, setNotice] = useState<string | null>(null);
  const RefreshIcon = appIcons.refresh;
  const SearchIcon = appIcons.search;
  const canToggle = supportsPluginToggle();
  const canSettings = supportsPluginSettings();

  async function load() {
    setLoading(true);
    setError(null);
    try {
      setDetails(await readPluginsDetails());
    } catch (loadError) {
      setError(formatError(loadError));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, []);

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

  const plugins = details?.plugins ?? [];
  const official = plugins.filter((plugin) => plugin.source === 'official');
  const user = plugins.filter((plugin) => plugin.source === 'user');
  const enabledCount = plugins.filter((plugin) => plugin.state === 'enabled').length;
  const visibleOfficial = useMemo(() => filterPlugins(official, filter), [official, filter]);
  const visibleUser = useMemo(() => filterPlugins(user, filter), [user, filter]);

  // 没选过就落在第一个插件上：右栏永远有内容，不会出现「先点一个才知道有什么」。
  const selected = plugins.find((plugin) => plugin.id === selectedId) ?? plugins[0];

  return (
    <PageFrame
      title="Plugins"
      path={details?.root}
      actions={
        <div className="toolbar">
          {notice ? <span className="save-status">{notice}</span> : null}
          <Button icon={<RefreshIcon size={15} />} title="重新加载" onClick={() => void load()} loading={loading} />
        </div>
      }
    >
      {error ? <Alert message={error} /> : null}
      {loading && !details ? (
        <div className="page-loading">正在加载 Plugins…</div>
      ) : (
        <div className="plugin-page">
          <SplitView
            rail={
              <>
                <div className="split-rail-head">
                  <div className="split-rail-filter">
                    <SearchIcon size={14} aria-hidden="true" />
                    <input
                      value={filter}
                      type="search"
                      aria-label="搜索插件"
                      placeholder={`搜索 ${plugins.length} 个插件`}
                      onChange={(event) => setFilter(event.target.value)}
                    />
                  </div>
                </div>
                <div className="split-rail-list" role="listbox" aria-label="插件列表">
                  <PluginRailGroup
                    title={`官方 · ${enabledCount}/${plugins.length} 启用`}
                    plugins={visibleOfficial}
                    selectedId={selected?.id}
                    onSelect={setSelectedId}
                    emptyText={official.length === 0 ? '没有官方插件' : '没有匹配的官方插件'}
                  />
                  <PluginRailGroup
                    title="用户"
                    plugins={visibleUser}
                    selectedId={selected?.id}
                    onSelect={setSelectedId}
                    emptyText={user.length === 0 ? '还没有安装用户插件' : '没有匹配的用户插件'}
                    hint={user.length === 0 ? '把插件目录放进上面那个路径后重新加载' : undefined}
                  />
                </div>
              </>
            }
          >
            {selected ? (
              <div className="plugin-detail">
                <PluginDetailHeader
                  plugin={selected}
                  busy={pendingId === selected.id}
                  canToggle={canToggle}
                  onToggleEnabled={(enabled) => void toggle(selected, enabled)}
                />
                <div className="plugin-detail-scroll">
                  <PluginBody plugin={selected} canSettings={canSettings} onSaved={setDetails} />
                </div>
              </div>
            ) : (
              <div className="page-loading">没有可显示的插件</div>
            )}
          </SplitView>
        </div>
      )}
    </PageFrame>
  );
}

function PluginRailGroup({
  title,
  plugins,
  selectedId,
  onSelect,
  emptyText,
  hint,
}: {
  title: string;
  plugins: ConfigWebPlugin[];
  selectedId?: string;
  onSelect(id: string): void;
  emptyText: string;
  hint?: string;
}) {
  return (
    <div className="split-rail-section">
      <p className="split-rail-group">{title}</p>
      {plugins.length === 0 ? (
        <div className="split-rail-empty">
          {emptyText}
          {hint ? <span className="split-rail-empty-hint">{hint}</span> : null}
        </div>
      ) : (
        plugins.map((plugin) => (
          <button
            key={plugin.id}
            type="button"
            role="option"
            aria-selected={plugin.id === selectedId}
            className={`split-item${plugin.id === selectedId ? ' is-active' : ''}`}
            title={`${plugin.name} · ${plugin.location}`}
            onClick={() => onSelect(plugin.id)}
          >
            <span className="split-item-copy">
              <span className="split-item-title">{plugin.name}</span>
              {/* 分组标题已经写明来源，行上再重复一遍没有信息量；这里放版本与例外状态。 */}
              <span className="split-item-meta">{railMeta(plugin)}</span>
            </span>
            <span className="split-item-trailing">
              <PluginStatusDot plugin={plugin} />
            </span>
          </button>
        ))
      )}
    </div>
  );
}

/** 列表行的状态点：异常优先于启停，因为「启用了但坏了」才是最需要看见的。 */
function PluginStatusDot({ plugin }: { plugin: ConfigWebPlugin }) {
  const tone =
    plugin.state === 'failed' || plugin.health?.level === 'error'
      ? 'red'
      : plugin.health?.level === 'warn'
        ? 'blue'
        : plugin.state === 'enabled'
          ? 'green'
          : 'default';
  const label = pluginHealthLabel(plugin);
  return <span className={`session-state-dot is-${tone}`} title={label} />;
}

function PluginDetailHeader({
  plugin,
  busy,
  canToggle,
  onToggleEnabled,
}: {
  plugin: ConfigWebPlugin;
  busy: boolean;
  canToggle: boolean;
  onToggleEnabled(enabled: boolean): void;
}) {
  const enabled = plugin.state !== 'disabled';
  return (
    <header className="plugin-detail-head">
      <div className="plugin-detail-title">
        <div className="plugin-detail-title-copy">
          <h2 title={plugin.name}>{plugin.name}</h2>
          <span className="plugin-detail-meta">
            v{plugin.version} · {pluginSourceLabel(plugin.source)} ·{' '}
            <span className="plugin-detail-location" title={plugin.location}>
              {plugin.location}
            </span>
          </span>
        </div>
        <div className="plugin-detail-actions">
          {plugin.state === 'failed' ? (
            <span className="plugin-state is-error">{pluginStateLabel(plugin.state)}</span>
          ) : null}
          <label className="plugin-toggle" title="停用后它的工具、命令与钩子都不会注册；重开会话生效">
            <Switch
              checked={enabled}
              disabled={!canToggle || busy}
              label={`${enabled ? '停用' : '启用'}插件 ${plugin.name}`}
              onChange={onToggleEnabled}
            />
            <span>{enabled ? '已启用' : '已停用'}</span>
          </label>
        </div>
      </div>
    </header>
  );
}

function PluginBody({
  plugin,
  canSettings,
  onSaved,
}: {
  plugin: ConfigWebPlugin;
  canSettings: boolean;
  onSaved(next: ConfigWebPluginsDetails): void;
}) {
  return (
    <>
      {plugin.description ? <p className="plugin-detail-description">{plugin.description}</p> : null}
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

      {plugin.settings.fields.length > 0 ? (
        <PluginSettingsForm plugin={plugin} canSave={canSettings} onSaved={onSaved} />
      ) : null}

      <SettingsGroup title="信息" description="入口、清单与日志都在磁盘上，排查时按这些路径找">
        <SettingRow label="标识">
          <span className="setting-row-value is-mono">{plugin.id}</span>
        </SettingRow>
        <SettingRow label="加载">
          <span className="setting-row-value">
            {pluginLoadStatusLabel(plugin.loadStatus ?? (plugin.source === 'official' ? 'loaded' : 'unknown'))}
          </span>
        </SettingRow>
        <SettingRow label="入口">
          <span className="setting-row-value is-mono" title={plugin.entryFile || '—'}>
            {plugin.entryFile || '—'}
          </span>
        </SettingRow>
        <SettingRow label="清单">
          <span className="setting-row-value is-mono" title={plugin.manifestFile || '—'}>
            {plugin.manifestFile || '—'}
          </span>
        </SettingRow>
        <SettingRow label="日志" hint="每个插件一份 JSONL，默认落在系统临时目录">
          <span className="setting-row-value is-mono" title={plugin.logFile}>
            {plugin.logFile}
          </span>
        </SettingRow>
        {plugin.author ? (
          <SettingRow label="作者">
            <span className="setting-row-value">{plugin.author}</span>
          </SettingRow>
        ) : null}
        <SettingRow
          label={
            <>
              文件<span className="config-field-count">{plugin.files.length}</span>
            </>
          }
        >
          {plugin.files.length === 0 ? (
            <span className="setting-row-value">没有可列出的文件</span>
          ) : (
            <ul className="plugin-file-list">
              {plugin.files.map((file) => (
                <li key={file.name}>
                  <span className="plugin-file-name" title={file.name}>
                    {file.name}
                  </span>
                  {/* 官方插件编译进产物、磁盘上没有文件，写「内置」一遍遍重复没有信息量 */}
                  {typeof file.sizeBytes === 'number' ? (
                    <span className="plugin-file-size">{formatBytes(file.sizeBytes)}</span>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </SettingRow>
      </SettingsGroup>
    </>
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
      {plugin.settings.fields.map((field) => (
        <SettingRow
          key={field.key}
          htmlFor={`plugin-setting-${field.key}`}
          label={
            <>
              {field.label}
              {field.required ? <span className="plugin-setting-required">必填</span> : null}
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
  );
}

function PluginSettingInput({
  field,
  value,
  disabled,
  invalid,
  onChange,
}: {
  field: ConfigWebPluginSetting;
  value: string;
  disabled: boolean;
  invalid: boolean;
  onChange(next: string): void;
}) {
  const inputId = `plugin-setting-${field.key}`;
  if (field.type === 'switch') {
    return (
      <Switch
        id={inputId}
        label={field.label}
        checked={value === 'true'}
        disabled={disabled}
        onChange={(checked) => onChange(checked ? 'true' : 'false')}
      />
    );
  }

  if (field.type === 'number') {
    const numeric = Number(value);
    const step = field.step ?? 1;
    const canStep = Number.isFinite(numeric);
    // 步进按钮落在同一条边框里，与输入框共用高度：原生 number 的上下箭头既占位
    // 又和 −/+ 重复，所以这里关掉它们（appearance: none 在样式里）。
    const nudge = (direction: 1 | -1) => {
      const base = canStep ? numeric : (field.min ?? 0);
      const next = base + step * direction;
      const clamped = Math.min(field.max === undefined ? next : field.max, field.min === undefined ? next : field.min);
      onChange(String(Number(clamped.toFixed(4))));
    };
    return (
      <span className={`config-stepper${invalid ? ' is-invalid' : ''}`}>
        <button type="button" className="config-stepper-btn" disabled={disabled} onClick={() => nudge(-1)}>
          −
        </button>
        <input
          id={inputId}
          className="text-input config-stepper-input"
          type="number"
          inputMode="numeric"
          value={value}
          min={field.min}
          max={field.max}
          step={step}
          disabled={disabled}
          onChange={(event) => onChange(event.target.value)}
        />
        <button type="button" className="config-stepper-btn" disabled={disabled} onClick={() => nudge(1)}>
          +
        </button>
        {field.unit ? <span className="config-stepper-unit">{field.unit}</span> : null}
      </span>
    );
  }

  // 枚举项自绘成按钮组：原生 select 的字号与内边距跟旁边的输入框对不齐。
  if (field.type === 'select') {
    return (
      <div className="config-segmented" role="group" aria-label={field.label} id={inputId}>
        {(field.options ?? []).map((option) => (
          <button
            key={option.value}
            type="button"
            className={`config-segment${value === option.value ? ' is-active' : ''}`}
            disabled={disabled}
            onClick={() => onChange(option.value)}
          >
            {option.label}
          </button>
        ))}
      </div>
    );
  }

  if (field.type === 'textarea') {
    return (
      <textarea
        id={inputId}
        className={`text-input text-input-multiline${invalid ? ' is-invalid' : ''}`}
        value={value}
        rows={4}
        spellCheck={false}
        placeholder={field.placeholder}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
      />
    );
  }

  return (
    <input
      id={inputId}
      className={`text-input${invalid ? ' is-invalid' : ''}`}
      type={field.type === 'password' ? 'password' : 'text'}
      value={value}
      spellCheck={false}
      autoComplete="off"
      placeholder={field.placeholder}
      disabled={disabled}
      onChange={(event) => onChange(event.target.value)}
    />
  );
}

function filterPlugins(plugins: ConfigWebPlugin[], filter: string): ConfigWebPlugin[] {
  const query = filter.trim().toLocaleLowerCase();
  if (!query) return plugins;
  return plugins.filter((plugin) =>
    `${plugin.name} ${plugin.id} ${plugin.description ?? ''}`.toLocaleLowerCase().includes(query),
  );
}

function railMeta(plugin: ConfigWebPlugin): string {
  const parts = [`v${plugin.version}`];
  if (plugin.state !== 'enabled') parts.push(pluginStateLabel(plugin.state));
  if (plugin.settings.fields.length > 0) parts.push('可设置');
  return parts.join(' · ');
}

function pluginHealthLabel(plugin: ConfigWebPlugin): string {
  if (plugin.state === 'failed') return '加载失败';
  if (plugin.health?.level === 'error') return '出错';
  if (plugin.health?.level === 'warn') return '待配置';
  return plugin.state === 'enabled' ? '正常' : '已停用';
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
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
