import { useRef, type KeyboardEvent } from 'react';
import { PageFrame } from '../components/PageFrame.js';
import { Empty, SettingRow, SettingsGroup, Tag } from '../components/Ui.js';
import { appIcons } from '../icons.js';
import { THEME_OPTIONS, useThemePreference, type ThemeOption } from '../theme.js';

/**
 * Appearance：界面主题。
 *
 * 三张单选卡对应 `THEME_OPTIONS`（跟随系统 / 浅色 / 深色）。主题能力由宿主提供
 * （`web/theme.ts` 的 `ConfigWebThemeHost`）：桌面端存运行时界面状态，浏览器宿主存
 * localStorage。页面只做展示与转发——点卡片当场调 `setPreference`，宿主立刻把
 * `<html data-theme>` 换掉，所有页面跟着变，不需要保存也不用重启。
 *
 * 主题卡里带一张迷你预览。预览不是截图、也不是为亮暗各写一套组件：它用一套局部
 * CSS 变量画出设置页的缩小版（`styles.css` 的 `.theme-preview`），「跟随系统」同时
 * 摆出亮暗两种样子，用户不用切过去试就知道选的是什么。
 */
export function AppearancePage() {
  const { preference, setPreference, available } = useThemePreference();
  const gridRef = useRef<HTMLDivElement>(null);

  // 没有注册主题宿主的宿主理论上不显示这个入口（侧栏按 hasConfigWebThemeHost 门控）；
  // 深链 / 宿主漏接时给空态，不给一张点了没反应的单选卡。
  if (!available) {
    return (
      <PageFrame title="外观" description="选择 Mica Code 的界面主题">
        <Empty description="当前宿主没有提供主题设置能力，这一页暂时不可用。" />
      </PageFrame>
    );
  }

  const current = THEME_OPTIONS.find((option) => option.value === preference);

  /**
   * 单选组的方向键：按顺序换一张卡并让它拿到焦点，和原生 radio 一致。
   * 不包成 effect / 状态机：选中值本身就是唯一事实来源。
   */
  function moveSelection(event: KeyboardEvent<HTMLDivElement>) {
    const step =
      event.key === 'ArrowRight' || event.key === 'ArrowDown'
        ? 1
        : event.key === 'ArrowLeft' || event.key === 'ArrowUp'
          ? -1
          : 0;
    if (step === 0) return;
    event.preventDefault();
    const index = THEME_OPTIONS.findIndex((option) => option.value === preference);
    const next = THEME_OPTIONS[(index + step + THEME_OPTIONS.length) % THEME_OPTIONS.length];
    if (!next) return;
    setPreference(next.value);
    gridRef.current?.querySelector<HTMLButtonElement>(`[data-theme-value='${next.value}']`)?.focus();
  }

  return (
    <PageFrame
      title="外观"
      description="选择 Mica Code 的界面主题；桌面端会同步到所有窗口，浏览器宿主存在这个浏览器里。"
    >
      <SettingsGroup
        title="主题"
        description="切换立即生效：点一下卡片就换，不需要保存或重启。"
        actions={current ? <Tag tone="blue">{current.label}</Tag> : null}
      >
        <SettingRow wide label="界面主题">
          <div
            className="theme-card-grid"
            role="radiogroup"
            aria-label="界面主题"
            ref={gridRef}
            onKeyDown={moveSelection}
          >
            {THEME_OPTIONS.map((option) => (
              <ThemeCard
                key={option.value}
                option={option}
                selected={option.value === preference}
                onSelect={() => setPreference(option.value)}
              />
            ))}
          </div>
        </SettingRow>
      </SettingsGroup>
    </PageFrame>
  );
}

function ThemeCard({ option, selected, onSelect }: { option: ThemeOption; selected: boolean; onSelect(): void }) {
  const CheckIcon = appIcons.check;
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      tabIndex={selected ? 0 : -1}
      data-theme-value={option.value}
      className={`theme-card${selected ? ' theme-card-active' : ''}`}
      onClick={onSelect}
    >
      <span className="theme-card-preview">
        {/* 跟随系统 = 两种主题都会出现，预览把亮暗并排摆出来。 */}
        {option.value === 'auto' ? (
          <span className="theme-card-split">
            <ThemePreview theme="light" />
            <ThemePreview theme="dark" />
          </span>
        ) : (
          <ThemePreview theme={option.value} />
        )}
      </span>
      <span className="theme-card-copy">
        <span className="theme-card-title">
          <span>{option.label}</span>
          {selected ? (
            <span className="theme-card-check">
              <CheckIcon size={13} strokeWidth={2.5} aria-hidden="true" />
            </span>
          ) : null}
        </span>
        <span className="theme-card-desc">{option.description}</span>
      </span>
    </button>
  );
}

/** 设置页的缩略图：侧栏 + 标题行 + 正文行 + 一块卡片 + 主按钮色块。 */
function ThemePreview({ theme }: { theme: 'light' | 'dark' }) {
  return (
    <span className="theme-preview" data-preview-theme={theme} aria-hidden="true">
      <span className="theme-preview-rail">
        <i />
        <i />
        <i />
      </span>
      <span className="theme-preview-main">
        <span className="theme-preview-line" />
        <span className="theme-preview-line is-short" />
        <span className="theme-preview-card" />
        <span className="theme-preview-button" />
      </span>
    </span>
  );
}
