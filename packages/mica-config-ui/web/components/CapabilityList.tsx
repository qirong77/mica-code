import { Switch } from './Ui.js';

/** 列表只认 key 与 label；`disabledKey` 之类由宿主各自保留在定义里。 */
export type CapabilityGroupDef = { key: string; label: string; disabledKey?: unknown };
export type CapabilityItem = { name: string; description: string };

/**
 * 能力列表：页签 + 计数行 + 「开关 / 名称 / 描述」三列。
 *
 * **设置页与会话弹窗共用这一份**——两处列的是同一批工具、技能与 MCP 服务，只是默认值
 * 与会话开关的数据源不同。之前各写一套，于是页签形态、列宽、能否点开详情全对不上。
 * 数据与落点由宿主决定，这里只管形态。
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
  onOpenDetail?: ((item: CapabilityItem) => void) | null;
}) {
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
        {items.map((item) => {
          const enabled = isEnabled(item.name);
          const id = `capability-${group}-${item.name}`;
          return (
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
                  id={id}
                  checked={enabled}
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
        })}
      </ul>
    </div>
  );
}
