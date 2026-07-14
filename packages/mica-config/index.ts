import {
  CONFIG_PATH,
  EFFORT_OPTIONS,
  PROVIDER_PROTOCOLS,
  readConfig,
  getConfig,
  updateConfig,
  loadProviderModels,
  loadMissingProviderModels,
  ensureModelRule,
  getModelRule,
  getModelEffortOptions,
  normalizeModelEffort,
  registerModelRuleResolver,
  registerModelRules,
  resolveModelRequestPatch,
  resolveChatCompletionsEffortParams,
  resolveResponsesReasoningParams,
} from './config.js';
import { runtimeEnv } from './runtimeEnv.js';
import {
  MICA_STORAGE_PATH,
  appendInputHistory,
  readLastUsedConfig,
  readInputHistory,
  readMicaStorage,
  readProviderPreference,
  updateLastUsedConfig,
  updateMicaStorage,
  updateProviderPreference,
} from './micaStorage.js';

export const micaConfig = {
  path: CONFIG_PATH,
  effortOptions: EFFORT_OPTIONS,
  providerProtocols: PROVIDER_PROTOCOLS,
  /** 从磁盘读取配置文件；缺失时会先写入默认配置。 */
  read: readConfig,
  /** 读取内存中的当前配置快照。 */
  get: getConfig,
  /** 通过 updater 修改配置，同时同步写回磁盘。 */
  update: updateConfig,
  /** 拉取指定 provider 的模型列表并缓存到内存运行态配置，不写回 config.json。 */
  loadProviderModels,
  /** 为配置中尚未加载模型列表的动态 provider 批量拉取模型。 */
  loadMissingProviderModels,
  /** 按模型名生成固定的模型规则。 */
  getModelRule,
  /** 确保模型规则已通过已注册的 resolver 加载。 */
  ensureModelRule,
  /** 返回当前模型支持的 effort 选项。 */
  getModelEffortOptions,
  /** 将不受模型支持的 effort 校正为模型默认值。 */
  normalizeModelEffort,
  /** 注册数据驱动的模型规则。 */
  registerModelRules,
  /** 注册异步模型规则解析器。 */
  registerModelRuleResolver,
  /** 解析模型在指定协议下的请求参数。 */
  resolveModelRequestPatch,
  /** 把统一 effort 转换为 Chat Completions 请求参数。 */
  resolveChatCompletionsEffortParams,
  /** 把统一 effort 转换为 Responses 请求参数。 */
  resolveResponsesReasoningParams,
  /** 运行时调参配置，只读取环境变量，不写入 config.json。 */
  runtimeEnv,
  storage: {
    path: MICA_STORAGE_PATH,
    read: readMicaStorage,
    update: updateMicaStorage,
    lastUsed: {
      read: readLastUsedConfig,
      update: updateLastUsedConfig,
    },
    providerPreference: {
      read: readProviderPreference,
      update: updateProviderPreference,
    },
  },
  inputHistory: {
    path: MICA_STORAGE_PATH,
    read: readInputHistory,
    append: appendInputHistory,
  },
};

export {
  ensureModelRule,
  getModelEffortOptions,
  getModelRule,
  normalizeModelEffort,
  providerSupportsModel,
  registerModelRuleResolver,
  registerModelRules,
  resolveModelRequestPatch,
  resolveChatCompletionsEffortParams,
  resolveResponsesReasoningParams,
} from './config.js';
export { readRuntimeEnvConfig, runtimeEnv } from './runtimeEnv.js';
export type { RuntimeEnvConfig, RuntimeEnvSource } from './runtimeEnv.js';
export type {
  EffortOption,
  EffortMap,
  ModelRule,
  ModelEffortRule,
  ModelRequestPatch,
  ProviderProtocol,
  ResolvedEffortParams,
  IMicaConfig,
  PersistedMicaConfig,
  ProviderDefinition,
} from './config.js';
export { isEffortOption, isProviderProtocol } from './types.js';
export {
  MICA_STORAGE_PATH,
  appendInputHistory,
  getCurrentDirectory,
  readInputHistory,
  readLastUsedConfig,
  readMicaStorage,
  readProviderPreference,
  updateLastUsedConfig,
  updateMicaStorage,
  updateProviderPreference,
} from './micaStorage.js';
export type { LastUsedConfig, MicaStorageFile, ProviderPreference } from './micaStorage.js';
