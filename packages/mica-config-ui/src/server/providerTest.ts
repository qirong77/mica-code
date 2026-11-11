import { probeModelConnection } from '@packages/mica-agent/index.js';
import { isProviderProtocol } from '@packages/mica-config/index.js';
import type { ConfigWebProviderTest, ConfigWebProviderTestInput } from '../shared/types.js';

/**
 * 服务商配置的「测试连接」。
 *
 * 用一次真实的模型请求回答「这套配置能不能用」：地址、Key、协议、模型里错哪一项都会在
 * 这里露出来，而不是等到发第一条消息才失败。执行器与插件试连是同一个
 * （`probeModelConnection` → `runModelTextRequest`），所以测通了就代表真的能发；它不记账、
 * 也不进任何会话。
 *
 * 入参是页面当前填的值，改完不用先保存再测。
 */
export async function testProviderConnection(input: ConfigWebProviderTestInput): Promise<ConfigWebProviderTest> {
  const baseUrl = input.apiBase.trim();
  const model = input.model.trim();
  if (!isProviderProtocol(input.protocol)) {
    return { ok: false, message: '请选择支持的模型协议', latencyMs: 0, model };
  }
  if (!model) {
    return { ok: false, message: '先给这个服务商填一个模型，才能发请求验证', latencyMs: 0, model };
  }
  return probeModelConnection({
    baseUrl,
    apiKey: input.apiKey || undefined,
    protocol: input.protocol,
    model,
  });
}
