import { Switch } from './Ui.js';
import { buildCapabilitySections } from '../capabilityGroups.js';
import type { CapabilityGroupRef } from '../capabilityGroups.js';

/** 列表只认 key 与 label；`disabledKey` 之类由宿主各自保留在定义里。 */
export type CapabilityGroupDef = { key: string; label: string; disabledKey?: unknown };

/** 入参摘要：详情里逐条列出，免得工具看起来「什么都没有」。 */
export type CapabilityParameter = {
  name: string;
  type: string;
  required: boolean;
  description: string;
};

export type CapabilityItem = {
  name: string;
  description: string;
  /** 所属分组；没有分组的项（技能、MCP 服务器）单独成行。 */
  group?: CapabilityGroupRef | null;
  /** 工具是否只读。 */
  readOnly?: boolean;
  /** 工具入参；skills / MCP server 没有。 */
  parameters?: CapabilityParameter[];
};

/**
 * 能力列表：页签 + 计数行 + 「开关 / 名称 / 描述」三列。
 *
 * **设置页与会话弹窗共用这一份**——两处列的是同一批工具、技能与 MCP 服务，只是默认值
 * 与会话开关的数据源不同。之前各写一套，于是页签形态、列宽、能否点开详情全对不上。
 * 数据与落点由宿主决定，这里只管形态。
 *
 * 工具按目录给的 `group` 分块：组头是同一个滑块加组名与 `启用/总数`，点它就是整组开关
 * （`onToggleGroup`）；组内每一行仍然可以单独开关。技能与 MCP 服务器没有分组，照旧平铺。
 *
 * 只有滑块改启用状态；整行点击留给「打开详情」，避免点名字误关工具。
 */
export function CapabilityList({
  groups,
  group,
  onGroupChange,
  counts,
  items,
  countLabel,
  status = null,
  isEnabled,
  disabled = false,
  onToggle,
  onToggleGroup = null,
  onOpenDetail = null,
}: {
  groups: CapabilityGroupDef[];
  group: string;
  onGroupChange(key: string): void;
  /** 每个页签角标上的 `启用/总数`。 */
  counts: Record<string, string>;
  items: CapabilityItem[];
  /** 计数行文案，例如 `24/24 启用`；由宿主决定说「默认启用」还是「启用」。 */
  countLabel: string;
  /** 计数行里的状态说明（改动未保存、已保存之类）。 */
  status?: string | null;
  isEnabled(name: string): boolean;
  disabled?: boolean;
  onToggle(name: string, enabled: boolean): void;
  /** 整组开关：`names` 是组内全部成员。不给时组头只显示，不可点。 */
  onToggleGroup?: ((names: string[], enabled: boolean) => void) | null;
  onOpenDetail?: ((item: CapabilityItem) => void) | null;
}) {
  const sections = buildCapabilitySections(items, isEnabled);

  const renderRow = (item: CapabilityItem) => (
    <li
      key={item.name}
      className={`capability-row${disabled ? ' is-disabled' : ''}${
        onOpenDetail ? ' is-clickable' : ''
      }`}
      onClick={onOpenDetail ? () => onOpenDetail(item) : undefined}
    >
      {/* 开关区拦住冒泡：点滑块只改启用状态，不打开详情 */}
      <span onClick={(event) => event.stopPropagation()}>
        <Switch
          id={`capability-${group}-${item.name}`}
          checked={isEnabled(item.name)}
          label={item.name}
          disabled={disabled}
          onChange={(checked) => onToggle(item.name, checked)}
        />
      </span>
      <span className="capability-name" title={item.name}>
        {item.name}
      </span>
      <span
        className={`capability-description${item.description ? '' : ' capability-description-empty'}`}
        title={item.description || undefined}
      >
        {item.description || '—'}
      </span>
    </li>
  );

  return (
    <div className="capability-list-block">
      <div className="session-tabs" role="tablist" aria-label="能力分类">
        {groups.map((entry) => (
          <button
            key={entry.key}
            type="button"
            role="tab"
            aria-selected={group === entry.key}
            className={`session-tab${group === entry.key ? ' session-tab-active' : ''}`}
            onClick={() => onGroupChange(entry.key)}
          >
            {entry.label}
            <span className="capability-tab-count">{counts[entry.key]}</span>
          </button>
        ))}
      </div>

      <div className="capability-toolbar">
        <span className="capability-count">
          {countLabel}
          {status ? <span className="capability-status">{status}</span> : null}
        </span>
      </div>

      <ul className="capability-list">
        {items.length === 0 ? <li className="capability-empty">暂无可用项</li> : null}
        {sections.map((section) => {
          if (section.key === null) {
            const item = section.items[0];
            return item ? renderRow(item) : null;
          }
          return (
            <li className="capability-group" key={`capability-group-${group}-${section.key}`}>
              <div
                className={`capability-group-head${disabled ? ' is-disabled' : ''}`}
                title={`${section.label}：${section.enabledCount}/${section.items.length} 启用`}
              >
                <span onClick={(event) => event.stopPropagation()}>
                  <Switch
                    id={`capability-group-${group}-${section.key}`}
                    checked={section.state === 'all'}
                    label={section.label ?? section.key}
                    disabled={disabled || !onToggleGroup}
                    onChange={(checked) =>
                      onToggleGroup?.(
                        section.items.map((item) => item.name),
                        checked
                      )
                    }
                  />
                </span>
                <span className="capability-group-label">{section.label}</span>
                <span className="capability-group-count">
                  {section.enabledCount}/{section.items.length}
                  {section.state === 'partial' ? ' · 部分启用' : ''}
                </span>
              </div>
              <ul className="capability-group-items">
                {section.items.map((item) => renderRow(item))}
              </ul>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/**
 * 入参列表：名称 / 类型（必填标记）/ 说明。
 *
 * 设置页与桌面端会话弹窗共用，两边只负责把 `parameters` 递进来。没有入参时整块不渲染，
 * 不显示一个空的「入参」标题。
 */
export function CapabilityParameters({
  parameters,
  label = '入参',
}: {
  parameters?: CapabilityParameter[] | null;
  label?: string;
}) {
  if (!parameters?.length) return null;
  return (
    <div className="capability-params-block">
      <span className="capability-detail-label">{label}</span>
      <ul className="capability-params">
        {parameters.map((parameter) => (
          <li className="capability-param" key={parameter.name}>
            <code className="capability-param-name" title={parameter.name}>
              {parameter.name}
            </code>
            <span className="capability-param-type" title={parameter.type}>
              {parameter.type}
              {parameter.required ? <span className="capability-param-required">必填</span> : null}
            </span>
            <span
              className={`capability-param-desc${parameter.description ? '' : ' is-empty'}`}
              title={parameter.description || undefined}
            >
              {parameter.description || '无说明'}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
