import {
  randomUserPrefixScenario,
  runComparison,
  stableSystemScenario,
} from "./shared";

await runComparison("Stable system prompt vs random user prefix", [
  stableSystemScenario(),
  randomUserPrefixScenario(),
]);
