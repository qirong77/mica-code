import { useState } from 'react';
// 深路径而不是包入口：mica-common 的 index 会一起导出读写文件的模块，
// 浏览器侧只认这个纯函数的子模块。
import { resolveUseMainProvider } from '@packages/mica-common/pluginLlm.js';
import type { ConfigWebPlugin, ConfigWebPluginLlmTest } from '../../src/shared/types.js';
import { testPluginLlm } from '../api.js';
import { Button, SettingRow, SettingsGroup, Tag } from './Ui.js';
import { PluginSettingInput } from './PluginSettingInput.js';

/**
 * 「这个插件要一个模型接口」的唯一样子。
 *
 * 清单里的 `llm` 声明会展开成几只普通字段（`group: 'llm'`），这里把它们收进同一块面板，
 * 并配一个「测试连接」：
 *
 * - 用户在填的时候就能知道通不通，不必等到某个后台任务静默失败；
 * - 测试走的是插件真正会用的那条请求（宿主侧同一个 `runModelTextRequest`），
 *   不存在「测试能通、跑起来不通」；
 * - 「跟随主配置」时其余字段隐藏，避免出现「填了但不生效」的错觉。
 */
export function LlmSettingsSection({
  plugin,
  values,
  errors,
  onChange,
  disabled,
}: {
  plugin: ConfigWebPlugin;
  values: Record<string, string>;
  errors: { key: string; label: string; message: string }[];
  onChange: (key: string, value: string) => void;
  disabled?: boolean;
}) {
  const llm = plugin.llm;
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<ConfigWebPluginLlmTest | null>(null);
  if (!llm) return null;

  const fields = plugin.settings.fields.filter((field) => field.group === 'llm');
  // 开关是「跟随主配置 / 自己填」的二选一，与内核用同一个判定：没表态时看有没有填地址。
  const followsMain = resolveUseMainProvider(llm.followMain, values);
  const visible = fields.filter((field) => !followsMain || field.key === 'useMainProvider');

  const runTest = async () => {
    setTesting(true);
    setResult(null);
    try {
      // 传当前表单值：用户不必先保存再测。
      setResult(await testPluginLlm(plugin.id, values));
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
          <Button variant="ghost" disabled={disabled || testing} onClick={() => void runTest()}>
            {testing ? '测试中…' : '测试连接'}
          </Button>
        </>
      }
    >
      {visible.map((field) => (
        <SettingRow
          key={field.key}
          label={field.label}
          hint={field.description}
          error={errors.find((issue) => issue.key === field.key)?.message}
          htmlFor={`plugin-setting-${field.key}`}
        >
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
