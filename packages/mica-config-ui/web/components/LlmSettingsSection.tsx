import { useState } from 'react';
// 深路径而不是包入口：mica-common 的 index 会一起导出读写文件的模块，
// 浏览器侧只认这个纯函数的子模块。
import { resolveUseMainProvider } from '@packages/mica-common/pluginLlm.js';
import type { ConfigWebPluginLlm, ConfigWebPluginLlmTest, ConfigWebPluginSetting } from '../../src/shared/types.js';
import { Button, SettingRow, SettingsGroup, Tag } from './Ui.js';
import { PluginSettingInput } from './PluginSettingInput.js';

/**
 * 「这个插件要一个模型接口」的唯一样子。
 *
 * 配置页的插件详情与桌面端的会话设置都用这一份：插件作者只声明清单里的 `llm`，
 * 不需要自己写模型表单，两个宿主也不会各长出一个「接口地址在哪填」的界面。
 *
 * - 拨到「复用当前会话模型」时，那几项独立配置直接隐藏，避免出现「填了但不生效」；
 * - 默认不用它：插件先按自己填的地址 / Key / 协议 / 模型发，失败才降级回会话模型；
 * - 右侧的状态只回答「配置齐没齐」，能不能通由「测试连接」回答（会话设置里不提供，
 *   它测的是全局配置，测出问题也会让人误以为是会话里的值）。
 */
export function LlmSettingsSection({
  llm,
  fields,
  values,
  errors,
  onChange,
  disabled,
  onTest,
  overrides,
  onReset,
  followLabel = '当前使用的模型',
}: {
  /** 清单没有 `llm` 声明时为 null：组件什么也不画，宿主不必自己判断。 */
  llm: ConfigWebPluginLlm | null;
  /** 全部插件字段；组件自己挑出 `group: 'llm'` 的那几项。 */
  fields: ConfigWebPluginSetting[];
  values: Record<string, string>;
  errors: { key: string; label: string; message: string }[];
  onChange: (key: string, value: string) => void;
  disabled?: boolean;
  /** 配置页才传：发一次真实请求验证。 */
  onTest?: (values: Record<string, string>) => Promise<ConfigWebPluginLlmTest>;
  /** 会话设置才传：本会话覆盖过的字段。 */
  overrides?: Record<string, string>;
  onReset?: (key: string) => void;
  followLabel?: string;
}) {
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<ConfigWebPluginLlmTest | null>(null);
  if (!llm) return null;

  const llmFields = fields.filter((field) => field.group === 'llm');
  const switchField = llmFields.find((field) => field.key === 'useMainProvider');
  const ownFields = llmFields.filter((field) => field.key !== 'useMainProvider');
  // 开关是「复用会话模型 / 自己填」的二选一，与内核用同一个判定。
  const followsMain = resolveUseMainProvider(values);

  const runTest = async () => {
    if (!onTest) return;
    setTesting(true);
    setResult(null);
    try {
      // 传当前表单值：用户不必先保存再测。
      setResult(await onTest(values));
    } catch (error) {
      setResult({
        ok: false,
        message: error instanceof Error ? error.message : String(error),
        latencyMs: 0,
        model: '',
      });
    } finally {
      setTesting(false);
    }
  };

  return (
    <SettingsGroup
      title={llm.label}
      description={llm.description}
      actions={
        <>
          {/* 这里只说「配置齐没齐」：能不能通由「测试连接」回答，别让标签替它下结论。 */}
          <Tag tone={llm.configured ? 'green' : 'red'}>{llm.configured ? '已配置' : '待配置'}</Tag>
          {onTest ? (
            <Button variant="ghost" disabled={disabled || testing} onClick={() => void runTest()}>
              {testing ? '测试中…' : '测试连接'}
            </Button>
          ) : null}
        </>
      }
    >
      {switchField ? (
        <SettingRow
          label={
            <>
              {switchField.label}
              {overridden(overrides, switchField.key) ? <span className="session-plugin-tag">仅本会话</span> : null}
            </>
          }
          hint={switchField.description}
          error={errors.find((issue) => issue.key === switchField.key)?.message}
          htmlFor={`plugin-setting-${switchField.key}`}
        >
          <div className="plugin-llm-control">
            <PluginSettingInput
              field={switchField}
              disabled={disabled ?? false}
              invalid={false}
              value={followsMain ? 'true' : 'false'}
              onChange={(next) => {
                onChange(switchField.key, next);
                setResult(null);
              }}
            />
            {overridden(overrides, switchField.key) ? (
              <button
                type="button"
                className="session-plugin-reset"
                disabled={disabled}
                onClick={() => onReset?.(switchField.key)}
              >
                跟随默认
              </button>
            ) : null}
          </div>
        </SettingRow>
      ) : null}

      {followsMain ? (
        <SettingRow
          label={followLabel}
          hint={
            llm.configured
              ? '失败时会自动降级到这里；换会话或切模型后，插件跟着走。'
              : '当前会话还没有可用的模型，请求会直接给出原因。'
          }
        >
          <span className="plugin-llm-summary">{llm.summary}</span>
        </SettingRow>
      ) : null}

      {followsMain
        ? null
        : ownFields.map((field) => (
            <SettingRow
              key={field.key}
              label={
                <>
                  {field.label}
                  {field.required ? <span className="plugin-setting-required">必填</span> : null}
                  {overridden(overrides, field.key) ? <span className="session-plugin-tag">仅本会话</span> : null}
                </>
              }
              hint={field.description}
              error={errors.find((issue) => issue.key === field.key)?.message}
              htmlFor={`plugin-setting-${field.key}`}
            >
              <div className="plugin-llm-control">
                <PluginSettingInput
                  field={field}
                  disabled={disabled ?? false}
                  invalid={errors.some((issue) => issue.key === field.key)}
                  value={values[field.key] ?? field.default ?? ''}
                  onChange={(next) => {
                    onChange(field.key, next);
                    // 改完配置，上一次的测试结论就过期了。
                    setResult(null);
                  }}
                />
                {overridden(overrides, field.key) ? (
                  <button
                    type="button"
                    className="session-plugin-reset"
                    disabled={disabled}
                    onClick={() => onReset?.(field.key)}
                  >
                    跟随默认
                  </button>
                ) : null}
              </div>
            </SettingRow>
          ))}

      {result ? <TestResult result={result} /> : null}
      {!result && !llm.configured ? (
        <p className="plugin-llm-hint">
          {followsMain
            ? '主配置里还没有可用的服务商，测试会直接给出原因。'
            : '填好接口地址与模型后可以点「测试连接」先确认一次。'}
        </p>
      ) : null}
    </SettingsGroup>
  );
}

function overridden(overrides: Record<string, string> | undefined, key: string): boolean {
  return Boolean(overrides && Object.prototype.hasOwnProperty.call(overrides, key));
}

function TestResult({ result }: { result: ConfigWebPluginLlmTest }) {
  if (result.ok) {
    return (
      <p className="plugin-llm-result is-ok">
        <span className="plugin-llm-result-dot" aria-hidden="true" />
        连接成功 · {formatLatency(result.latencyMs)} · {result.model}
        {result.reply ? ` · 回复「${result.reply}」` : ''}
      </p>
    );
  }
  return (
    <p className="plugin-llm-result is-error">
      <span className="plugin-llm-result-dot" aria-hidden="true" />
      {result.message || '连接失败'}
    </p>
  );
}

function formatLatency(ms: number): string {
  if (!ms) return '未发出请求';
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}
