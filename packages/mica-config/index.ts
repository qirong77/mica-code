import {
  CONFIG_PATH,
  PROVIDER_PROTOCOLS,
  providerForModel,
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
  resolveEffortParams,
  readCapabilityDefaults,
  updateCapabilityDefaults,
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
  /** 当前主配置的接口地址 / Key / 协议 / 模型（插件「跟随主配置」与配置页试连用它）。 */
  readActiveProviderConfig,
  /** 这个模型实际由哪个 provider 服务（模型元数据要按它查）。 */
  providerForModel: (model: string | undefined) => providerForModel(getConfig(), model),
  /** 注册数据驱动的模型规则。 */
  registerModelRules,
  /** 注册异步模型规则解析器。 */
  registerModelRuleResolver,
  /** 把 effort 解析成指定协议、指定模型真正要发送的请求参数。 */
  resolveEffortParams,
  /** 新会话默认能力（config.json 的 capabilityDefaults）。 */
  readCapabilityDefaults,
  /** 保存新会话默认能力；不改动已有会话。 */
  updateCapabilityDefaults,
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
  providerForModel,
  registerModelRuleResolver,
  registerModelRules,
  resolveEffortParams,
} from './config.js';
export type { EffortParamsRequest } from './config.js';
export { readCapabilityDefaults, updateCapabilityDefaults } from './config.js';
import { readActiveProviderConfig } from './activeProvider.js';
export { readActiveProviderConfig } from './activeProvider.js';
export type { ActiveProviderConfig } from './activeProvider.js';
export { readRuntimeEnvConfig, runtimeEnv } from './runtimeEnv.js';
export type { RuntimeEnvConfig, RuntimeEnvSource } from './runtimeEnv.js';
export type {
  EffortOption,
  KnownEffortLevel,
  ModelRule,
  ModelEffortRule,
  ModelRequestPatch,
  ProviderProtocol,
  ResolvedEffortParams,
  IMicaConfig,
  PersistedMicaConfig,
  ProviderDefinition,
} from './config.js';
export { isEffortLevelName, isProviderProtocol } from './types.js';
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
export {
  APP_NAME,
  CONFIG_DIR_NAME,
  RUNTIME_NAME,
  VERSION_LABEL,
  resolveMicaHome,
  resolveMicaHomePath,
} from './brand.js';
