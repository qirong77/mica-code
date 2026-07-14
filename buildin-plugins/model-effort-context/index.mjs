import { registerModelRules } from '../../packages/mica-config/getModelRule.js';
import rules from './models.json' with { type: 'json' };

export default function setupModelEffortContext() {
  return registerModelRules(rules);
}
