import { registerModelRuleResolver } from '@packages/mica-config/getModelRule.js';
import { getModelRule, getSeedModelRule } from './getModelRule.js';

export default function setupModelEffortContext(): () => void {
  return registerModelRuleResolver(getModelRule, getSeedModelRule);
}
