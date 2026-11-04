import { useState } from 'react';
import { appIcons } from '../icons.js';
import { providerProtocolLabel } from '../labels.js';
import { PROVIDER_PROTOCOL_VALUES, readProviderDraft, type ProviderDraft } from '../configDraft.js';
import type { ConfigWebProviderTest, ConfigWebProviderTestInput } from '../../src/shared/types.js';
import { Button, SettingRow } from './Ui.js';
import { SecretInput } from './SecretInput.js';

type ProviderEditorProps = {
  raw: unknown;
  index: number;
  /** 取这个 provider 上某个字段的错误文案（键是字段名，不含 `providers.N.`）。 */
  errorFor(field: string): string | undefined;
  removable: boolean;
  expanded: boolean;
  /** 校验出错时强制展开，避免错误藏在折叠行里。 */
  hasError: boolean;
  disabled?: boolean;
  /** 配置页才传：用当前填的值发一次真实请求，验证这套配置能不能用。 */
  onTest?(input: ConfigWebProviderTestInput): Promise<ConfigWebProviderTest>;
  onToggleExpanded(): void;
  onChange(next: ProviderDraft): void;
  onRemove(): void;
};

/**
 * 一个服务商：折叠时是一行摘要，展开后是同一块面里的字段行。
 *
 * 所有值都来自外部 draft（受控），组件自身只留「正在输入的模型名」、折叠开关与上一次
 * 试连的结论，所以父级重新加载或撤销时不会残留旧值。默认折叠——多数时候只是看看配置，
 * 不需要每次把七八个输入框都铺开。
 */
export function ProviderEditor({
  raw,
  index,
  errorFor,
  removable,
  expanded,
  hasError,
  disabled = false,
  onTest,
  onToggleExpanded,
  onChange,
  onRemove,
}: ProviderEditorProps) {
  const fields = readProviderDraft(raw);
  const [modelInput, setModelInput] = useState('');
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<ConfigWebProviderTest | null>(null);
  const TrashIcon = appIcons.trash;
  const ChevronIcon = appIcons.chevronRight;
  const open = expanded || hasError;

  function patch(next: Partial<ProviderDraft>) {
    // 改了配置，上一次的试连结论就过期了。
    setTestResult(null);
    onChange({ ...fields, ...next });
  }

  /**
   * 试连用列表里的第一个模型：它是折叠摘要里的「N 个模型」中的第一个，也是新会话没有
   * 默认模型时会选中的那个。一个模型都没有时不发请求——没有模型名就无从验证。
   */
  const testModel = fields.models[0] ?? '';

  async function runTest() {
    if (!onTest || !testModel) return;
    setTesting(true);
    setTestResult(null);
    try {
      setTestResult(
        await onTest({ apiBase: fields.apiBase, apiKey: fields.apiKey, protocol: fields.protocol, model: testModel }),
      );
    } catch (error) {
      setTestResult({
        ok: false,
        message: error instanceof Error ? error.message : String(error),
        latencyMs: 0,
        model: testModel,
      });
    } finally {
      setTesting(false);
    }
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
    <article className={`provider-row${open ? ' is-open' : ''}`}>
      <header className="provider-row-head">
        <button
          type="button"
          className="provider-row-toggle"
          aria-expanded={open}
          title={open ? '收起' : '展开编辑'}
          onClick={onToggleExpanded}
        >
          <ChevronIcon size={13} className="provider-row-chevron" aria-hidden="true" />
          <span className="provider-row-name" title={fields.id}>
            {fields.id.trim() || '新的服务商'}
          </span>
          <span className="provider-row-protocol">{providerProtocolLabel(fields.protocol)}</span>
          <span className="provider-row-meta" title={fields.apiBase}>
            {summaryText(fields)}
          </span>
        </button>
        {hasError ? <span className="provider-row-flag">待修正</span> : null}
        <Button
          icon={<TrashIcon size={14} />}
          variant="ghost"
          title={removable ? '删除这个服务商' : '至少保留一个服务商'}
          ariaLabel="删除服务商"
          disabled={!removable || disabled}
          onClick={onRemove}
        />
      </header>

      {open ? (
        <div className="provider-row-body">
          <SettingRow label="名称" hint="会话里按这个名字引用" error={errorFor('id')}>
            <input
              className={invalidClass(errorFor('id'))}
              value={fields.id}
              disabled={disabled}
              spellCheck={false}
              placeholder="例如 deepseek"
              aria-label={`服务商 ${index + 1} 名称`}
              aria-invalid={Boolean(errorFor('id'))}
              onChange={(event) => patch({ id: event.target.value })}
            />
          </SettingRow>

          <SettingRow label="API Base" error={errorFor('api_base')}>
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
          </SettingRow>

          <SettingRow label="API Key" hint="留空表示不需要鉴权" error={errorFor('api_key')}>
            <SecretInput
              value={fields.apiKey}
              disabled={disabled}
              placeholder="sk-…"
              ariaLabel={`服务商 ${index + 1} API Key`}
              invalid={Boolean(errorFor('api_key'))}
              onChange={(apiKey) => patch({ apiKey })}
            />
          </SettingRow>

          <SettingRow label="协议" error={errorFor('protocol')}>
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
          </SettingRow>

          <SettingRow
            label={
              <>
                模型
                {fields.models.length > 0 ? <span className="config-field-count">{fields.models.length}</span> : null}
              </>
            }
            error={errorFor('models')}
          >
            {fields.models.length === 0 ? (
              <p className="config-field-hint">填上这个服务商提供的模型名，至少一个才能发消息。</p>
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
          </SettingRow>

          {onTest ? (
            <SettingRow
              label="连接"
              hint={
                testModel
                  ? `用上面的地址与 Key 发一次最小请求（模型 ${testModel}），不写进会话。`
                  : '先在上面添加一个模型，才能发请求验证地址与 Key。'
              }
            >
              <div className="provider-test">
                <Button disabled={disabled || testing || !testModel} onClick={() => void runTest()}>
                  {testing ? '测试中…' : '测试连接'}
                </Button>
                {testResult ? (
                  <span className={`provider-test-result${testResult.ok ? ' is-ok' : ' is-error'}`}>
                    {describeTestResult(testResult)}
                  </span>
                ) : null}
              </div>
            </SettingRow>
          ) : null}
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

function invalidClass(message?: string): string {
  return message ? 'text-input text-input-invalid' : 'text-input';
}

/** 试连结果压成一行：成功给耗时与模型，失败给执行器说的那句话。 */
function describeTestResult(result: ConfigWebProviderTest): string {
  if (!result.ok) return result.message || '连接失败';
  const latency = result.latencyMs < 1000 ? `${result.latencyMs}ms` : `${(result.latencyMs / 1000).toFixed(1)}s`;
  return `连接成功 · ${latency} · ${result.model}${result.reply ? ` · 回复「${result.reply}」` : ''}`;
}
