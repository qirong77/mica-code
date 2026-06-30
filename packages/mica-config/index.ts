import {
  CONFIG_PATH,
  EFFORT_OPTIONS,
  PROVIDER_PROTOCOLS,
  DEFAULT_PROVIDER_PROTOCOL,
  readConfig,
  getConfig,
  updateConfig,
  validateConfig,
  assertValidConfig,
  formatConfigValidationIssues,
  loadProviderModels,
  loadMissingProviderModels,
  getEffortMapFromConfig,
  getModelContextWindowSizeFromConfig,
  getProviderEffortOptions,
  clampProviderEffort,
  mapProviderEffortValue,
  providerSupportsModel,
  resolveChatCompletionsEffortParams,
  resolveResponsesReasoningParams,
  resolveProviderProtocol,
} from './config.js';
import { runtimeEnv } from './runtimeEnv.js';
import { INPUT_HISTORY_PATH, appendInputHistory, readInputHistory } from './inputHistory.js';
import {
  MICA_STORAGE_PATH,
  readLastUsedConfig,
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
  defaultProviderProtocol: DEFAULT_PROVIDER_PROTOCOL,
  /** 从磁盘读取配置文件；缺失时会先写入默认配置。 */
  read: readConfig,
  /** 读取内存中的当前配置快照。 */
  get: getConfig,
  /** 通过 updater 修改配置，同时同步写回磁盘。 */
  update: updateConfig,
  /** 校验配置文件语义，返回 error/warning 列表，不直接抛错。 */
  validate: validateConfig,
  /** 校验配置文件语义；存在 error 时抛出带完整提示的 ConfigValidationError。 */
  assertValid: assertValidConfig,
  /** 把配置校验问题格式化成面向用户的可读文本。 */
  formatValidationIssues: formatConfigValidationIssues,
  /** 拉取指定 provider 的模型列表并缓存到内存运行态配置，不写回 config.json。 */
  loadProviderModels,
  /** 为配置中尚未加载模型列表的动态 provider 批量拉取模型。 */
  loadMissingProviderModels,
  /** 按模型名从内置规则读取 effort 映射；未命中时返回默认四档。 */
  getEffortMapFromConfig,
  /** 按模型名从内置规则读取 context window token 数；未命中时返回 256K。 */
  getModelContextWindowSizeFromConfig,
  /** 获取当前 provider 实际可选的 effort。 */
  getProviderEffortOptions,
  /** 把 effort 修正到当前 provider 支持的最近可用值。 */
  clampProviderEffort,
  /** 获取 provider 实际发送的 reasoning effort 值。 */
  mapProviderEffortValue,
  /** 把统一 effort 转换为 Chat Completions 请求参数。 */
  resolveChatCompletionsEffortParams,
  /** 把统一 effort 转换为 Responses 请求参数。 */
  resolveResponsesReasoningParams,
  /** 读取 provider 协议，缺省为 OpenAI Chat Completions。 */
  resolveProviderProtocol,
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
    path: INPUT_HISTORY_PATH,
    read: readInputHistory,
    append: appendInputHistory,
  },
};

export {
  ConfigValidationError,
  validateConfig,
  assertValidConfig,
  formatConfigValidationIssues,
  getEffortMapFromConfig,
  getModelContextWindowSizeFromConfig,
  getProviderEffortOptions,
  clampProviderEffort,
  mapProviderEffortValue,
  providerSupportsModel,
  resolveChatCompletionsEffortParams,
  resolveResponsesReasoningParams,
  resolveProviderProtocol,
} from './config.js';
export { readRuntimeEnvConfig, runtimeEnv } from './runtimeEnv.js';
export type { RuntimeEnvConfig, RuntimeEnvSource } from './runtimeEnv.js';
export type {
  EffortOption,
  EffortMap,
  ModelRule,
  ProviderProtocol,
  ResolvedEffortParams,
  IMicaConfig,
  PersistedMicaConfig,
  ProviderDefinition,
  ConfigValidationIssue,
  ConfigValidationResult,
  ConfigValidationSeverity,
} from './config.js';
export { INPUT_HISTORY_PATH, appendInputHistory, readInputHistory } from './inputHistory.js';
export type { InputHistoryFile } from './inputHistory.js';
export {
  MICA_STORAGE_PATH,
  getCurrentDirectory,
  readLastUsedConfig,
  readMicaStorage,
  readProviderPreference,
  updateLastUsedConfig,
  updateMicaStorage,
  updateProviderPreference,
} from './micaStorage.js';
export type { LastUsedConfig, MicaStorageFile, ProviderPreference } from './micaStorage.js';
