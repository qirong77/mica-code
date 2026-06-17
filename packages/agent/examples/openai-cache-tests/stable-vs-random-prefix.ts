// 稳定 system prompt vs 随机 system 前缀对比测试
// 验证：system prompt 最前面插入随机 nonce 会完全破坏 prompt 缓存命中。
// 预期：稳定场景付费占比接近 0%（大量缓存命中），随机前缀场景付费占比接近 100%。

import { randomSystemPrefixScenario, runComparison, stableSystemScenario } from './shared';

await runComparison('稳定 system prompt vs 随机 system 前缀', [
  stableSystemScenario(),
  randomSystemPrefixScenario(),
]);
