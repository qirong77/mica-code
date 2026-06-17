import {
  randomSystemPrefixScenario,
  randomSystemSuffixScenario,
  randomUserPrefixScenario,
  runComparison,
  stableSystemScenario,
} from "./openai-cache-tests/shared";

await runComparison("OpenAI prompt cache comparison matrix", [
  stableSystemScenario(),
  randomSystemPrefixScenario(),
  randomSystemSuffixScenario(),
  randomUserPrefixScenario(),
]);
