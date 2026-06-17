import { randomSystemPrefixScenario, runComparison, stableSystemScenario } from './shared';

await runComparison('Stable system prompt vs random system prefix', [
  stableSystemScenario(),
  randomSystemPrefixScenario(),
]);
