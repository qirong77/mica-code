import { useState } from 'react';
import { appIcons } from '../icons.js';
import { providerProtocolLabel } from '../labels.js';
import { PROVIDER_PROTOCOL_VALUES, readProviderDraft, type ProviderDraft } from '../configDraft.js';
import { Button } from './Ui.js';

type ProviderEditorProps = {
  raw: unknown;
  index: number;
  /** 取这个 provider 上某个字段的错误文案（键是字段名，不含 `providers.N.`）。 */
  errorFor(field: string): string | undefined;
  revealed: boolean;
  removable: boolean;
  expanded: boolean;
  /** 校验出错时强制展开，避免错误藏在折叠卡片里。 */
  hasError: boolean;
  disabled?: boolean;
  onToggleReveal(): void;
  onToggleExpanded(): void;
  onChange(next: ProviderDraft): void;
  onRemove(): void;
};

/**
 * 一个服务商的字段编辑块。
 *
 * 所有值都来自外部 draft（受控），组件自身只留「正在输入的模型名」与两个折叠开关，
 * 所以父级重新加载或撤销时不会残留旧值。默认折叠成一行摘要——多数时候只是看看配置，
 * 不需要每次把七八个输入框都铺开。
 */
export function ProviderEditor({
  raw,
  index,
  errorFor,
  revealed,
  removable,
  expanded,
  hasError,
  disabled = false,
  onToggleReveal,
  onToggleExpanded,
  onChange,
  onRemove,
}: ProviderEditorProps) {
  const fields = readProviderDraft(raw);
  const [modelInput, setModelInput] = useState('');
  const TrashIcon = appIcons.trash;
  const ShowIcon = appIcons.show;
  const HideIcon = appIcons.hide;
  const ChevronIcon = appIcons.chevronRight;
  const open = expanded || hasError;

  function patch(next: Partial<ProviderDraft>) {
    onChange({ ...fields, ...next });
  }

  function addModel() {
    const name = modelInput.trim();
    if (!name) return;
    if (!fields.models.includes(name)) patch({ models: [...fields.models, name] });
    setModelInput('');
  }

  function removeModel(name: string) {
    patch({ models: fields.models.filter((model) => model !== name) });
  }

  return (
    <article className={`config-provider${open ? ' is-open' : ''}`}>
      <header className="config-provider-head">
        <button
          type="button"
          className="config-provider-toggle"
          aria-expanded={open}
          title={open ? '收起' : '展开编辑'}
          onClick={onToggleExpanded}
        >
          <ChevronIcon size={13} className="config-provider-chevron" />
          <span className="config-provider-title" title={fields.name || fields.id}>
            {fields.name.trim() || fields.id.trim() || '新的服务商'}
          </span>
          <span className="config-provider-protocol">{providerProtocolLabel(fields.protocol)}</span>
          <span className="config-provider-meta" title={fields.apiBase}>
            {summaryText(fields)}
          </span>
        </button>
        {hasError ? <span className="config-provider-flag">待修正</span> : null}
        <Button
          icon={<TrashIcon size={14} />}
          title={removable ? '删除这个服务商' : '至少保留一个服务商'}
          ariaLabel="删除服务商"
          disabled={!removable || disabled}
          onClick={onRemove}
        />
      </header>

      {open ? (
        <div className="config-provider-body">
          <div className="config-provider-grid">
            <label className="form-field">
              <span>标识</span>
              <input
                className={invalidClass(errorFor('id'))}
                value={fields.id}
                disabled={disabled}
                spellCheck={false}
                placeholder="会话里引用这个名字，例如 deepseek"
                aria-label={`服务商 ${index + 1} 标识`}
                aria-invalid={Boolean(errorFor('id'))}
                onChange={(event) => patch({ id: event.target.value })}
              />
              <FieldError message={errorFor('id')} />
            </label>
            <label className="form-field">
              <span>显示名称</span>
              <input
                className="text-input"
                value={fields.name}
                disabled={disabled}
                placeholder="可选"
                aria-label={`服务商 ${index + 1} 显示名称`}
                onChange={(event) => patch({ name: event.target.value })}
              />
              <FieldError message={errorFor('name')} />
            </label>
          </div>

          <div className="config-provider-grid">
            <label className="form-field">
              <span>API Base</span>
              <input
                className={invalidClass(errorFor('api_base'))}
                value={fields.apiBase}
                disabled={disabled}
                spellCheck={false}
                placeholder="https://api.example.com"
                aria-label={`服务商 ${index + 1} API Base`}
                aria-invalid={Boolean(errorFor('api_base'))}
                onChange={(event) => patch({ apiBase: event.target.value })}
              />
              <FieldError message={errorFor('api_base')} />
            </label>

            <label className="form-field">
              <span>API Key</span>
              <span className="config-input-with-action">
                <input
                  className={invalidClass(errorFor('api_key'))}
                  type={revealed ? 'text' : 'password'}
                  value={fields.apiKey}
                  disabled={disabled}
                  spellCheck={false}
                  autoComplete="off"
                  placeholder="留空表示不需要鉴权"
                  aria-label={`服务商 ${index + 1} API Key`}
                  aria-invalid={Boolean(errorFor('api_key'))}
                  onChange={(event) => patch({ apiKey: event.target.value })}
                />
                <button
                  type="button"
                  className="config-input-action"
                  title={revealed ? '隐藏明文' : '显示明文'}
                  aria-label={revealed ? '隐藏明文' : '显示明文'}
                  onClick={onToggleReveal}
                >
                  {revealed ? <HideIcon size={14} /> : <ShowIcon size={14} />}
                </button>
              </span>
              <FieldError message={errorFor('api_key')} />
            </label>
          </div>

          <div className="config-provider-grid">
            <div className="form-field">
              <span>协议</span>
              <div className="config-segmented" role="radiogroup" aria-label={`服务商 ${index + 1} 协议`}>
                {PROVIDER_PROTOCOL_VALUES.map((value) => (
                  <button
                    key={value}
                    type="button"
                    role="radio"
                    aria-checked={fields.protocol === value}
                    className={`config-segment${fields.protocol === value ? ' is-active' : ''}`}
                    disabled={disabled}
                    onClick={() => patch({ protocol: value })}
                  >
                    {providerProtocolLabel(value)}
                  </button>
                ))}
              </div>
              <FieldError message={errorFor('protocol')} />
            </div>

            <label className="form-field">
              <span>模型列表地址</span>
              <input
                className={invalidClass(errorFor('get_model_url'))}
                value={fields.getModelUrl}
                disabled={disabled}
                spellCheck={false}
                placeholder="可选，例如 https://api.example.com/models"
                aria-label={`服务商 ${index + 1} 模型列表地址`}
                aria-invalid={Boolean(errorFor('get_model_url'))}
                onChange={(event) => patch({ getModelUrl: event.target.value })}
              />
              <FieldError message={errorFor('get_model_url')} />
            </label>
          </div>

          <div className="form-field">
            <span>
              模型
              {fields.models.length > 0 ? <span className="config-field-count">{fields.models.length}</span> : null}
            </span>
            {fields.models.length === 0 ? (
              <p className="config-field-hint">
                {fields.getModelUrl.trim()
                  ? '留空时会从「模型列表地址」自动拉取。'
                  : '留空时使用运行时按模型名推断的规则。'}
              </p>
            ) : (
              <div className="config-chip-list">
                {fields.models.map((model) => (
                  <span className="config-chip" key={model}>
                    <span className="config-chip-label" title={model}>
                      {model}
                    </span>
                    <button
                      type="button"
                      className="config-chip-remove"
                      title={`移除 ${model}`}
                      aria-label={`移除模型 ${model}`}
                      disabled={disabled}
                      onClick={() => removeModel(model)}
                    >
                      ×
                    </button>
                  </span>
                ))}
              </div>
            )}
            <form
              className="config-chip-add"
              onSubmit={(event) => {
                event.preventDefault();
                addModel();
              }}
            >
              <input
                className="text-input"
                value={modelInput}
                disabled={disabled}
                spellCheck={false}
                placeholder="输入模型名后回车添加"
                aria-label={`服务商 ${index + 1} 新增模型`}
                onChange={(event) => setModelInput(event.target.value)}
              />
              <Button disabled={disabled || !modelInput.trim()} onClick={addModel}>
                添加
              </Button>
            </form>
            <FieldError message={errorFor('models')} />
          </div>
        </div>
      ) : null}
    </article>
  );
}

/** 折叠状态下的一行摘要：地址与模型数量，够判断是哪套配置。 */
function summaryText(fields: ProviderDraft): string {
  const base = fields.apiBase.trim().replace(/^https?:\/\//, '');
  const models = fields.models.length > 0 ? `${fields.models.length} 个模型` : '未列模型';
  return base ? `${base} · ${models}` : models;
}

function FieldError({ message }: { message?: string }) {
  return message ? <span className="config-field-error">{message}</span> : null;
}

function invalidClass(message?: string): string {
  return message ? 'text-input text-input-invalid' : 'text-input';
}
