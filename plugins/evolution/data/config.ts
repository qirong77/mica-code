import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { writeTextFileAtomic } from '@packages/mica-config/atomicWrite.js';
import type { DataMigration } from './types.js';

/**
 * 动态模型发现被移除（模型列表改成 config.json 里手填）之后的配置收敛。
 *
 * 旧配置里留下两类死数据：
 * - `providers[].get_model_url`：以前按它拉模型列表，现在没有任何代码读它，留着会让用户
 *   以为自己配的地址还在生效；
 * - `defaultModel` 的 `provider` / `model` 为空：旧版本在「用列表里的第一个模型」时会把空值
 *   留在配置里，新代码不再有列表可拉，空字符串会一路走到「这个服务商没有可用模型」。
 *   清掉这一项，新会话就回到正常的默认（第一个服务商、它声明的第一个模型）。
 *
 * provider 上的 `models` 保留：它以前是拉下来的缓存，现在正是手填的模型清单——旧缓存
 * 直接变成可用的列表，用户升级后不必重新填一遍。
 */
export const configModelDiscovery: DataMigration = {
  id: 'config-model-discovery',
  description: '删掉 config.json 里已无消费方的 get_model_url，并清掉空的默认模型（回落到第一个服务商的模型）',
  run({ home }) {
    const file = join(home, 'config.json');
    if (!existsSync(file)) return 0;
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(file, 'utf-8'));
    } catch {
      // 配置坏了有它自己的报错路径，迁移不覆盖。
      return 0;
    }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return 0;
    const config = raw as Record<string, unknown>;
    let changed = 0;

    if (Array.isArray(config.providers)) {
      for (const entry of config.providers) {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
        const provider = entry as Record<string, unknown>;
        if ('get_model_url' in provider) {
          delete provider.get_model_url;
          changed += 1;
        }
      }
    }

    const defaults = config.defaultModel;
    if (defaults && typeof defaults === 'object' && !Array.isArray(defaults)) {
      const record = defaults as Record<string, unknown>;
      const provider = typeof record.provider === 'string' ? record.provider.trim() : '';
      const model = typeof record.model === 'string' ? record.model.trim() : '';
      if (!provider || !model) {
        delete config.defaultModel;
        changed += 1;
      }
    }

    if (changed === 0) return 0;
    writeTextFileAtomic(file, `${JSON.stringify(config, null, 2)}\n`);
    return changed;
  },
};
