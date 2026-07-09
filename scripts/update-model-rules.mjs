#!/usr/bin/env node

import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const MODELS_URL = 'https://opencode.ai/zen/v1/models/';
const OUTPUT_PATH = resolve(process.cwd(), 'packages/mica-config/model-rules.json');
const UNKNOWN_RULE_NAME = 'Unverified OpenCode Models';
const LEGACY_UNKNOWN_RULE_NAMES = new Set([UNKNOWN_RULE_NAME, 'Other OpenCode Models']);

const response = await fetch(MODELS_URL, { headers: { Accept: 'application/json' } });
if (!response.ok) {
  throw new Error(`Failed to fetch ${MODELS_URL}: HTTP ${response.status}`);
}

const listedIds = parseModelIds(await response.json());
const listedIdSet = new Set(listedIds);
const existingRules = await readExistingRules();
const preservedRules = [];
const preservedIds = new Set();

for (const rule of existingRules) {
  if (LEGACY_UNKNOWN_RULE_NAMES.has(rule.name)) continue;
  const modelKeysIncludes = rule.modelKeysIncludes.filter((key) => key === 'glm' || listedIdSet.has(key));
  if (modelKeysIncludes.length === 0) continue;
  preservedRules.push({ ...rule, modelKeysIncludes });
  for (const key of modelKeysIncludes) {
    if (key !== 'glm') preservedIds.add(key);
  }
}

const unverifiedIds = listedIds.filter((id) => !preservedIds.has(id) && !matchesPreservedKey(id, preservedRules));
const output = [...preservedRules];

if (unverifiedIds.length > 0) {
  output.push({
    name: UNKNOWN_RULE_NAME,
    modelKeysIncludes: unverifiedIds,
    contextSize: 256,
    enableEffort: false,
  });
}

await writeFile(OUTPUT_PATH, `${JSON.stringify(output, null, 2)}\n`, 'utf-8');
console.log(`Updated ${OUTPUT_PATH}`);
console.log(`Fetched ${listedIds.length} models, preserved ${preservedRules.length} verified rules.`);
console.log(`${unverifiedIds.length} models still need search-backed contextSize/effortMap verification.`);

async function readExistingRules() {
  const content = await readFile(OUTPUT_PATH, 'utf-8');
  const rules = JSON.parse(content);
  if (!Array.isArray(rules)) throw new Error(`${OUTPUT_PATH} must contain a JSON array`);
  return rules.filter(isModelRule);
}

function parseModelIds(payload) {
  if (!payload || !Array.isArray(payload.data)) {
    throw new Error('Unexpected OpenCode Zen models response: expected { data: Model[] }');
  }
  return [
    ...new Set(
      payload.data
        .map((model) => model?.id)
        .filter((id) => typeof id === 'string' && id.trim().length > 0)
        .map((id) => id.trim().toLowerCase()),
    ),
  ].sort((a, b) => a.localeCompare(b));
}

function isModelRule(value) {
  return (
    value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Array.isArray(value.modelKeysIncludes) &&
    value.modelKeysIncludes.every((key) => typeof key === 'string' && key.length > 0)
  );
}

function matchesPreservedKey(id, rules) {
  return rules.some((rule) => rule.modelKeysIncludes.some((key) => key !== id && id.includes(key)));
}
