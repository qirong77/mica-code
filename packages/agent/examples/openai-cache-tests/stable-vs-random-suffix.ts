import {
  randomSystemSuffixScenario,
  runComparison,
  stableSystemScenario,
} from "./shared";

await runComparison("Stable system prompt vs random system suffix", [
  stableSystemScenario(),
  randomSystemSuffixScenario(),
]);
