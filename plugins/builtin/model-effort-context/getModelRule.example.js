import { getModelRule } from './getModelRule.js';

// Expected values cross-checked with vendor documentation and the matching
// first-party entries in https://models.dev/api.json.
const models = {
  'gpt-5.4': { contextSize: 1050000, efforts: ['none', 'low', 'medium', 'high', 'xhigh'] },
  'claude-opus-4-6': { contextSize: 1000000, efforts: ['low', 'medium', 'high', 'xhigh'] },
  'claude-sonnet-4-6': { contextSize: 1000000, efforts: ['low', 'medium', 'high', 'xhigh'] },
  'gemini-3.1-pro-preview': { contextSize: 1048576, efforts: ['low', 'medium', 'high'] },
  'gemini-2.5-pro': { contextSize: 1048576, efforts: ['high'] },
  'grok-4.5': { contextSize: 500000, efforts: ['low', 'medium', 'high'] },
  'deepseek-reasoner': { contextSize: 1000000, efforts: ['high'] },
  'deepseek-chat': { contextSize: 1000000, efforts: [] },
  'kimi-k2.6': { contextSize: 262144, efforts: ['none', 'high'] },
};

let consistent = true;

for (const [modelName, expected] of Object.entries(models)) {
  try {
    const rule = await getModelRule(modelName);
    const actualEfforts = Object.keys(rule.efforts);
    const matches =
      rule.contextSize === expected.contextSize && JSON.stringify(actualEfforts) === JSON.stringify(expected.efforts);

    consistent &&= matches;
    console.log(`\n${matches ? 'PASS' : 'FAIL'} ${modelName}`);
    console.log(JSON.stringify(rule, null, 2));

    if (!matches) console.error('Expected:', JSON.stringify(expected));
  } catch (error) {
    consistent = false;
    console.error(`\nERROR ${modelName}:`, error instanceof Error ? error.message : error);
  }
}

console.log(`\n${consistent ? 'All model rules are consistent.' : 'Some model rules are inconsistent.'}`);
if (!consistent) process.exitCode = 1;
