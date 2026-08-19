import { registerModelRuleResolver } from '@packages/mica-config/getModelRule.js';
import { getModelRule } from './getModelRule.js';

export default function setupModelEffortContext(): () => void {
  return registerModelRuleResolver(getModelRule);
}
