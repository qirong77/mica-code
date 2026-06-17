// 稳定 system prompt vs 随机 system 后缀对比测试
// 验证：system prompt 末尾追加随机 nonce 不会影响前缀缓存命中。
// 预期：两个场景付费占比接近（system 前半部分稳定部分仍可被缓存）。

import { randomSystemSuffixScenario, runComparison, stableSystemScenario } from './shared';

await runComparison('稳定 system prompt vs 随机 system 后缀', [
  stableSystemScenario(),
  randomSystemSuffixScenario(),
]);
