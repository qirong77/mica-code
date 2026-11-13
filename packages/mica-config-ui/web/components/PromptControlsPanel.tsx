import { useEffect, useRef, useState } from 'react';
import type { PromptControls, PromptSectionSnapshot, RuntimePromptInspection } from '@packages/mica-common/promptControls.js';
import { Button, Empty, Switch } from './Ui.js';
import { JsonEditor } from './JsonEditor.js';
import { CAPABILITY_LABELS as L, promptSectionLabel } from '../labels.js';
import {
  effectivePromptSection,
  movePromptSection,
  orderedPromptSections,
  restorePromptSection,
  setPluginPromptEnabled,
  setPromptSection,
} from '../promptControlDraft.js';
import { appIcons } from '../icons.js';

type DropTarget = { id: string; position: 'before' | 'after' };

/**
 * 提示词控制：一行就是 Agent 提示词里的一段。
 *
 * 顺序、开关、正文各自独立存储，但都落在同一份 `PromptControls` 里；界面显示的排列
 * 就是下一轮拼装的排列，拖动只调整可编辑段落，`system` 固定在首位。
 */
export function PromptControlsPanel({
  inspection,
  controls,
  onChange,
  focusId,
  onFocus,
  pluginNames,
  disabled = false,
}: {
  inspection: RuntimePromptInspection | null;
  controls: PromptControls;
  onChange(controls: PromptControls): void;
  focusId: string;
  onFocus(id: string): void;
  pluginNames?: Record<string, string>;
  disabled?: boolean;
}) {
  const sections = inspection ? orderedPromptSections(inspection.sections, controls) : [];
  const [openIds, setOpenIds] = useState<string[]>([]);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<DropTarget | null>(null);
  const rowRefs = useRef<Record<string, HTMLDivElement | null>>({});

  useEffect(() => {
    const ids = new Set(sections.map((section) => section.id));
    setOpenIds((current) => current.filter((id) => ids.has(id)));
  }, [inspection]);

  useEffect(() => {
    if (!focusId || !sections.some((section) => section.id === focusId)) return;
    setOpenIds((current) => (current.includes(focusId) ? current : [...current, focusId]));
    requestAnimationFrame(() => rowRefs.current[focusId]?.scrollIntoView({ block: 'nearest' }));
  }, [focusId, sections]);

  function setOpen(id: string, open: boolean) {
    onFocus(id);
    setOpenIds((current) => (open ? [...new Set([...current, id])] : current.filter((entry) => entry !== id)));
  }

  function drop(target: DropTarget) {
    if (draggingId) onChange(movePromptSection(sections, controls, draggingId, target.id, target.position));
    setDraggingId(null);
    setDropTarget(null);
  }

  /** 键盘替代：把手聚焦后用 ↑/↓ 上移下移一位。 */
  function nudge(id: string, delta: -1 | 1) {
    const editable = sections.filter((section) => section.editable).map((section) => section.id);
    const index = editable.indexOf(id);
    const neighbour = editable[index + delta];
    if (index < 0 || !neighbour) return;
    onChange(movePromptSection(sections, controls, id, neighbour, delta < 0 ? 'before' : 'after'));
  }

  if (!inspection) return <Empty description={L.noRuntime} />;

  return (
    <div className="prompt-control-list">
      {sections.map((section) => (
        <PromptSectionRow
          key={section.id}
          section={section}
          controls={controls}
          open={openIds.includes(section.id)}
          disabled={disabled}
          pluginName={section.pluginId ? (pluginNames?.[section.pluginId] ?? section.pluginId) : null}
          dragging={draggingId === section.id}
          dropPosition={dropTarget?.id === section.id ? dropTarget.position : null}
          rowRef={(element) => {
            rowRefs.current[section.id] = element;
          }}
          onToggleOpen={(open) => setOpen(section.id, open)}
          onDragStart={() => setDraggingId(section.id)}
          onDragOver={(position) => {
            if (draggingId && draggingId !== section.id) setDropTarget({ id: section.id, position });
          }}
          onDrop={(position) => drop({ id: section.id, position })}
          onDragEnd={() => {
            setDraggingId(null);
            setDropTarget(null);
          }}
          onNudge={(delta) => nudge(section.id, delta)}
          onChange={onChange}
        />
      ))}
      {!sections.length ? <Empty description="当前会话没有可查看的提示词" /> : null}
    </div>
  );
}

const PromptSectionRow = ({
  section,
  controls,
  open,
  disabled,
  pluginName,
  dragging,
  dropPosition,
  rowRef,
  onToggleOpen,
  onDragStart,
  onDragOver,
  onDrop,
  onDragEnd,
  onNudge,
  onChange,
}: {
  section: PromptSectionSnapshot;
  controls: PromptControls;
  open: boolean;
  disabled: boolean;
  pluginName: string | null;
  dragging: boolean;
  dropPosition: 'before' | 'after' | null;
  rowRef(element: HTMLDivElement | null): void;
  onToggleOpen(open: boolean): void;
  onDragStart(): void;
  onDragOver(position: 'before' | 'after'): void;
  onDrop(position: 'before' | 'after'): void;
  onDragEnd(): void;
  onNudge(delta: -1 | 1): void;
  onChange(controls: PromptControls): void;
}) => {
  const [showOriginal, setShowOriginal] = useState(false);
  const body = useBodyAnimation(open);
  const effective = effectivePromptSection(section, controls);
  const overridden = controls.sections[section.id]?.content !== undefined;
  const text = showOriginal ? section.originalContent : effective.content;
  const title = promptSectionLabel(section.id, section.label);
  const draggable = section.editable && !disabled;
  const ChevronIcon = appIcons.chevronRight;
  const GripIcon = appIcons.grip;

  return (
    <div
      ref={rowRef}
      className={[
        'prompt-control-row',
        open ? 'is-open' : '',
        dragging ? 'is-dragging' : '',
        dropPosition === 'before' ? 'is-drop-before' : '',
        dropPosition === 'after' ? 'is-drop-after' : '',
        effective.enabled ? '' : 'is-off',
      ]
        .filter(Boolean)
        .join(' ')}
    >
      <div
        className="prompt-control-head"
        onDragOver={(event) => {
          if (!draggable) return;
          event.preventDefault();
          const rect = event.currentTarget.getBoundingClientRect();
          onDragOver(event.clientY > rect.top + rect.height / 2 ? 'after' : 'before');
        }}
        onDrop={(event) => {
          if (!draggable) return;
          event.preventDefault();
          const rect = event.currentTarget.getBoundingClientRect();
          onDrop(event.clientY > rect.top + rect.height / 2 ? 'after' : 'before');
        }}
      >
        {draggable ? (
          <span
            className="prompt-control-grip"
            role="button"
            tabIndex={0}
            draggable
            aria-label={`调整${title}的顺序`}
            title="拖动调整顺序"
            onDragStart={(event) => {
              event.dataTransfer.effectAllowed = 'move';
              onDragStart();
            }}
            onDragEnd={onDragEnd}
            onKeyDown={(event) => {
              if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
              event.preventDefault();
              onNudge(event.key === 'ArrowUp' ? -1 : 1);
            }}
          >
            <GripIcon size={14} aria-hidden="true" />
          </span>
        ) : (
          <span className="prompt-control-grip is-static" aria-hidden="true" />
        )}
        <button type="button" className="prompt-control-toggle" aria-expanded={open} onClick={() => onToggleOpen(!open)}>
          <span className="prompt-control-title">{title}</span>
          {pluginName ? <span className="prompt-control-source">{pluginName}</span> : null}
          {!section.editable ? <span className="prompt-control-source">只读</span> : null}
          <ChevronIcon className="prompt-control-chevron" size={15} aria-hidden="true" />
        </button>
        <Switch
          label={`${title} 提示词`}
          checked={effective.enabled}
          disabled={disabled || !section.editable}
          onChange={(enabled) => onPromptEnabled(section, enabled, controls, onChange, disabled)}
        />
      </div>
      {body.mounted ? (
        <div className={`prompt-control-body-wrap${body.expanded ? ' is-open' : ''}`}>
          <div className="prompt-control-body">
            <div className={`editor-host prompt-control-editor${effective.content.trim() ? '' : ' is-empty'}`}>
              <JsonEditor
                key={`${section.id}:${showOriginal}`}
                language="markdown"
                value={text}
                readOnly={disabled || !section.editable || showOriginal}
                onChange={(content) => {
                  if (!disabled && section.editable && !showOriginal) {
                    onChange(setPromptSection(controls, section.id, { content }));
                  }
                }}
              />
            </div>
            <div className="prompt-control-actions">
              {!effective.content.trim() ? <span>当前为空，不会注入</span> : <span />}
              <div className="toolbar">
                {section.editable ? (
                  <Button
                    size="compact"
                    variant="ghost"
                    pressed={showOriginal}
                    onClick={() => setShowOriginal((current) => !current)}
                  >
                    {showOriginal ? '返回编辑' : '原文'}
                  </Button>
                ) : null}
                {overridden ? (
                  <Button
                    size="compact"
                    variant="ghost"
                    disabled={disabled}
                    onClick={() => {
                      setShowOriginal(false);
                      onChange(restorePromptSection(controls, section.id));
                    }}
                  >
                    {L.restore}
                  </Button>
                ) : null}
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
};

function onPromptEnabled(
  section: PromptSectionSnapshot,
  enabled: boolean,
  controls: PromptControls,
  onChange: (controls: PromptControls) => void,
  disabled: boolean,
) {
  if (disabled || !section.editable) return;
  let next = setPromptSection(controls, section.id, { enabled });
  if (section.pluginId && enabled && controls.disabledPlugins.includes(section.pluginId)) {
    next = setPluginPromptEnabled(next, section.pluginId, true);
  }
  onChange(next);
}

/** 与 styles.css 里 `.prompt-control-body-wrap` 的过渡时长保持一致。 */
const BODY_ANIMATION_MS = 160;

/**
 * 展开时先挂载再放开高度，收起时先收高度再卸载：编辑器不进 DOM 就不会拖慢长列表，
 * 但收起仍然有过渡而不是瞬间消失。
 */
function useBodyAnimation(open: boolean) {
  const [mounted, setMounted] = useState(open);
  const [expanded, setExpanded] = useState(open);

  useEffect(() => {
    if (open) {
      setMounted(true);
      // 两帧：先让折叠（0fr）那一版真正画出来，再放开高度，过渡才会跑。
      let inner = 0;
      const outer = requestAnimationFrame(() => {
        inner = requestAnimationFrame(() => setExpanded(true));
      });
      return () => {
        cancelAnimationFrame(outer);
        cancelAnimationFrame(inner);
      };
    }
    setExpanded(false);
    const timer = window.setTimeout(() => setMounted(false), BODY_ANIMATION_MS);
    return () => window.clearTimeout(timer);
  }, [open]);

  return { mounted, expanded };
}
