import {
  CONFIG_PATH,
  EFFORT_OPTIONS,
  readConfig,
  getConfig,
  updateConfig,
  validateConfig,
  assertValidConfig,
  formatConfigValidationIssues,
  loadProviderModels,
  loadMissingProviderModels,
} from './config.js';
import { INPUT_HISTORY_PATH, appendInputHistory, readInputHistory } from './inputHistory.js';

export const micaConfig = {
  path: CONFIG_PATH,
  effortOptions: EFFORT_OPTIONS,
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
  /** 拉取指定 provider 的模型列表并更新本地配置。 */
  loadProviderModels,
  /** 为配置中尚未缓存模型列表的 provider 批量拉取模型。 */
  loadMissingProviderModels,
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
} from './config.js';
export type {
  EffortOption,
  IMicaConfig,
  ProviderDefinition,
  ConfigValidationIssue,
  ConfigValidationResult,
  ConfigValidationSeverity,
} from './config.js';
export { INPUT_HISTORY_PATH, appendInputHistory, readInputHistory } from './inputHistory.js';
export type { InputHistoryFile } from './inputHistory.js';
