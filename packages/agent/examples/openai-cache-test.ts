// 全量对比矩阵：稳定 system vs 随机 system 前缀 vs 随机 system 后缀 vs 随机 user 前缀
// 用于一次性运行所有缓存策略对比实验。

import {
  randomSystemPrefixScenario,
  randomSystemSuffixScenario,
  randomUserPrefixScenario,
  runComparison,
  stableSystemScenario,
} from './openai-cache-tests/shared';

await runComparison('OpenAI prompt 缓存对比矩阵', [
  stableSystemScenario(),
  randomSystemPrefixScenario(),
  randomSystemSuffixScenario(),
  randomUserPrefixScenario(),
]);