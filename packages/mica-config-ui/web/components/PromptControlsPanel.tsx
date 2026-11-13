import { useMemo, useState } from 'react';
import type { PromptControls, RuntimePromptInspection } from '@packages/mica-common/promptControls.js';
import { JsonEditor } from './JsonEditor.js';
import { Button, Empty, SplitView, Switch, Tag } from './Ui.js';
import { CAPABILITY_LABELS as L, promptSectionLabel } from '../labels.js';
import {
  effectivePromptSection,
  previewPrompt,
  restorePromptSection,
  setPluginPromptEnabled,
  setPromptSection,
} from '../promptControlDraft.js';

export function PromptControlsPanel({
  inspection,
  controls,
  onChange,
  query,
  selectedId,
  onSelect,
  disabled = false,
}: {
  inspection: RuntimePromptInspection | null;
  controls: PromptControls;
  onChange(controls: PromptControls): void;
  query: string;
  selectedId: string;
  onSelect(id: string): void;
  disabled?: boolean;
}) {
  const [showOriginal, setShowOriginal] = useState(false);
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState<string | null>(null);
  const sections = inspection?.sections ?? [];
  const selected = sections.find((section) => section.id === selectedId);
  const effective = selected ? effectivePromptSection(selected, controls) : null;
  const preview = useMemo(() => previewPrompt(sections, controls), [sections, controls]);
  const isSent = selectedId === 'sent';
  const isFull = !selected;
  const text = isFull
    ? isSent
      ? (inspection?.lastSent ?? '')
      : preview
    : showOriginal
      ? selected.originalContent
      : (effective?.content ?? '');
  const overridden = selected ? controls.sections[selected.id]?.content !== undefined : false;
  const title = isFull ? (isSent ? L.lastSent : L.preview) : promptSectionLabel(selected.id, selected.label);
  const matching = sections.filter((section) =>
    `${promptSectionLabel(section.id, section.label)} ${section.id} ${section.originalContent}`
      .toLowerCase()
      .includes(query.toLowerCase()),
  );

  function select(id: string) {
    onSelect(id);
    setShowOriginal(false);
    setCopied(false);
    setCopyError(null);
  }

  async function copy() {
    try {
      if (!navigator.clipboard?.writeText) throw new Error('当前环境不支持自动复制，请在编辑器中选择正文复制。');
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setCopyError(null);
    } catch (cause) {
      setCopyError(cause instanceof Error ? cause.message : String(cause));
    }
  }

  if (!inspection) return <Empty description={L.noRuntime} />;

  return (
    <div className="capability-prompt-panel">
      <p className="capability-note">{L.promptScope}</p>
      <SplitView
        rail={
          <>
            <div className="capability-prompt-summary">
              <span>{inspection.role}</span>
              <span title={inspection.cwd}>{inspection.cwd}</span>
            </div>
            {[
              { id: 'preview', label: L.preview },
              { id: 'sent', label: L.lastSent },
            ].map((entry) => (
              <button
                key={entry.id}
                type="button"
                className={`split-item${selectedId === entry.id ? ' is-active' : ''}`}
                onClick={() => select(entry.id)}
              >
                <span className="split-item-title">{entry.label}</span>
              </button>
            ))}
            <div className="capability-prompt-section-label">按来源控制</div>
            {matching.map((section) => {
              const resolved = effectivePromptSection(section, controls);
              return (
                <div
                  key={section.id}
                  className={`capability-prompt-row${selectedId === section.id ? ' is-active' : ''}`}
                >
                  <button
                    type="button"
                    className="capability-prompt-source"
                    onClick={() => select(section.id)}
                    title={section.id}
                  >
                    <span>{promptSectionLabel(section.id, section.label)}</span>
                    <small>
                      {section.pluginId ?? 'Agent'} · {resolved.content.length.toLocaleString()} 字符
                      {controls.sections[section.id]?.content !== undefined ? ' · 已覆盖' : ''}
                    </small>
                  </button>
                  <Switch
                    label={`${section.label} 提示词`}
                    checked={resolved.enabled}
                    disabled={
                      disabled ||
                      !section.editable ||
                      Boolean(section.pluginId && controls.disabledPlugins.includes(section.pluginId))
                    }
                    onChange={(enabled) => onChange(setPromptSection(controls, section.id, { enabled }))}
                  />
                </div>
              );
            })}
            {!matching.length ? <div className="capability-empty">没有匹配的提示词段落</div> : null}
          </>
        }
      >
        <div className="capability-prompt-editor">
          <div className="capability-prompt-heading">
            <div>
              <strong>{title}</strong>
              <span>
                {text.length.toLocaleString()} 字符 · ≈{Math.ceil(text.length / 4).toLocaleString()} tokens（估算）
              </span>
            </div>
            <div className="toolbar">
              {selected && !selected.editable ? <Tag>只读</Tag> : null}
              {selected && overridden ? <Tag tone="blue">{L.overridden}</Tag> : null}
              {selected && !effective?.enabled ? <Tag>未注入</Tag> : null}
              {selected && effective?.enabled && !effective.content.trim() ? <Tag>暂无内容</Tag> : null}
              <Button size="compact" variant="ghost" onClick={() => void copy()}>
                {copied ? L.copied : L.copy}
              </Button>
            </div>
          </div>
          {selected ? (
            <div className="capability-prompt-actions">
              <span className="muted-text" title={selected.id}>
                {selected.pluginId ? `插件 ${selected.pluginId} / ${selected.sectionId}` : selected.id}
              </span>
              <div className="toolbar">
                {selected.pluginId && controls.disabledPlugins.includes(selected.pluginId) ? (
                  <Button
                    size="compact"
                    variant="ghost"
                    disabled={disabled}
                    onClick={() => onChange(setPluginPromptEnabled(controls, selected.pluginId!, true))}
                  >
                    开启插件注入
                  </Button>
                ) : null}
                {selected.editable ? (
                  <Button
                    size="compact"
                    variant="ghost"
                    pressed={showOriginal}
                    onClick={() => setShowOriginal(!showOriginal)}
                  >
                    {showOriginal ? '返回编辑' : '查看原文'}
                  </Button>
                ) : null}
                {overridden ? (
                  <Button
                    size="compact"
                    variant="ghost"
                    disabled={disabled}
                    onClick={() => {
                      setShowOriginal(false);
                      onChange(restorePromptSection(controls, selected.id));
                    }}
                  >
                    {L.restore}
                  </Button>
                ) : null}
              </div>
            </div>
          ) : null}
          {copyError ? (
            <p role="alert" className="capability-note">
              {copyError}
            </p>
          ) : null}
          {isSent && !inspection.lastSent ? (
            <Empty description={L.noLastSent} />
          ) : (
            <div className="editor-host capability-prompt-editor-host">
              <JsonEditor
                key={`${selectedId}:${showOriginal}`}
                language="markdown"
                value={text}
                readOnly={disabled || isFull || !selected?.editable || showOriginal}
                onChange={(content) => {
                  if (!disabled && selected?.editable && !showOriginal) {
                    setCopied(false);
                    onChange(setPromptSection(controls, selected.id, { content }));
                  }
                }}
              />
            </div>
          )}
          <p className="capability-prompt-footnote">
            {isSent
              ? '存档只读：保留最近一次实际请求的完整系统提示词。'
              : isFull
                ? '预览使用当前来源正文与控制草稿；动态段落在实际请求时会重新生成。工具定义在 Tools / MCP 页签单独查看。'
                : showOriginal
                  ? '这里是来源生成的原文；恢复原文后，动态段落会继续随插件状态更新。'
                  : selected?.editable
                    ? '停手后自动保存为正文覆盖；“恢复原文”可重新使用来源生成的内容。'
                    : '默认系统提示词始终保留。'}
            {inspection.running && !isSent ? ' 当前有轮次正在运行，修改将在下一轮生效。' : ''}
          </p>
        </div>
      </SplitView>
    </div>
  );
}
