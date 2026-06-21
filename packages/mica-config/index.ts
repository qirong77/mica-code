import {
  CONFIG_PATH,
  EFFORT_OPTIONS,
  readConfig,
  getConfig,
  updateConfig,
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

export type { EffortOption, IMicaConfig, ProviderDefinition } from './config.js';
export { INPUT_HISTORY_PATH, appendInputHistory, readInputHistory } from './inputHistory.js';
export type { InputHistoryFile } from './inputHistory.js';
