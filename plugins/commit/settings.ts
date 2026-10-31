import type { PluginLlmApi, PluginSettingValues } from '@packages/mica-plugin/index.js';
import { DEFAULT_PROMPT } from './message.js';

/**
 * 插件设置 → 一次 commit message 请求要用的参数。
 *
 * 模型接口不在这里：清单里的 `llm` 声明生成了接口地址 / Key / 协议 / 模型四项，
 * 「跟随主配置」（默认）由宿主解析，插件只从 `ctx.llm` 读生效值。这里只剩提示词与
 * 推送开关这两件与模型无关的事。
 */

export type CommitSettings = {
  prompt: string;
  push: boolean;
};

export function readCommitSettings(values: PluginSettingValues): CommitSettings {
  return {
    prompt: (values.prompt ?? '').trim() || DEFAULT_PROMPT,
    push: (values.push ?? 'true') !== 'false',
  };
}

/**
 * 发请求前的可用性判断。
 *
 * 返回一句话理由而不是布尔：命令要把它同时写进健康状态和用户可见的提示里，
 * 用户据此知道是「没配」还是「主配置本身没有 provider」。
 */
export function commitLlmProblem(llm: PluginLlmApi | undefined): string | null {
  if (!llm) return '插件运行环境没有提供模型接口（requires 里缺 llm）';
  if (!llm.configured()) return '未配置模型接口：请在插件设置里复用当前会话模型，或填写接口地址与模型';
  return null;
}
