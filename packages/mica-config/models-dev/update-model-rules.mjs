#!/usr/bin/env node

import { readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { format, resolveConfig } from 'prettier';

const MODELS_URL = 'https://models.dev/models.json';
const PROVIDERS_URL = 'https://models.dev/api.json';
const OUTPUT_PATH = resolve(dirname(fileURLToPath(import.meta.url)), '../model-rules.json');
const PREFERRED_PROVIDER = 'opencode';
const EFFORT_OPTIONS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

const options = parseArguments(process.argv.slice(2));
if (options.help) {
  printHelp();
  process.exit(0);
}

const [modelsPayload, providersPayload, existingContent] = await Promise.all([
  fetchJson(MODELS_URL),
  fetchJson(PROVIDERS_URL),
  readFile(OUTPUT_PATH, 'utf-8'),
]);

const existingRules = parseRules(existingContent);
const catalog = createCatalog(modelsPayload, providersPayload);
const { rules, changes, warnings, matchedKeys } = updateRules(existingRules, catalog);
const prettierConfig = (await resolveConfig(OUTPUT_PATH)) ?? {};
const output = await format(JSON.stringify(rules), { ...prettierConfig, parser: 'json' });
const changed = output !== existingContent;

printSummary({ changes, warnings, matchedKeys, totalKeys: countModelKeys(existingRules), changed });

if (options.check) {
  if (changed) {
    console.error(`${OUTPUT_PATH} is out of date. Run bun run update:model-rules:models-dev.`);
    process.exitCode = 1;
  }
} else if (options.dryRun) {
  console.log(changed ? 'Dry run complete; no file was written.' : 'Dry run complete; rules are already current.');
} else if (changed) {
  await writeOutputAtomically(output);
  console.log(`Updated ${OUTPUT_PATH}`);
} else {
  console.log(`${OUTPUT_PATH} is already current.`);
}

function parseArguments(args) {
  const supported = new Set(['--check', '--dry-run', '--help', '-h']);
  const unknown = args.filter((arg) => !supported.has(arg));
  if (unknown.length > 0) throw new Error(`Unknown argument: ${unknown.join(', ')}`);
  if (args.includes('--check') && args.includes('--dry-run')) {
    throw new Error('--check and --dry-run cannot be used together');
  }
  return {
    check: args.includes('--check'),
    dryRun: args.includes('--dry-run'),
    help: args.includes('--help') || args.includes('-h'),
  };
}

function printHelp() {
  console.log(`Update mica-config model rules from Models.dev.

Usage:
  bun packages/mica-config/models-dev/update-model-rules.mjs [option]

Options:
  --dry-run  Fetch and compare data without writing model-rules.json
  --check    Exit with code 1 when model-rules.json is out of date
  --help     Show this help message`);
}

async function fetchJson(url) {
  let response;
  try {
    response = await fetch(url, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(30_000),
    });
  } catch (error) {
    throw new Error(`Failed to fetch ${url}`, { cause: error });
  }
  if (!response.ok) throw new Error(`Failed to fetch ${url}: HTTP ${response.status}`);
  try {
    return await response.json();
  } catch (error) {
    throw new Error(`Failed to parse JSON from ${url}`, { cause: error });
  }
}

function parseRules(content) {
  let value;
  try {
    value = JSON.parse(content);
  } catch (error) {
    throw new Error(`${OUTPUT_PATH} contains invalid JSON`, { cause: error });
  }
  if (!Array.isArray(value) || !value.every(isModelRule)) {
    throw new Error(`${OUTPUT_PATH} must contain an array of model rules`);
  }
  return value;
}

function isModelRule(value) {
  return (
    value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Array.isArray(value.modelKeysIncludes) &&
    value.modelKeysIncludes.length > 0 &&
    value.modelKeysIncludes.every((key) => typeof key === 'string' && key.trim().length > 0)
  );
}

async function writeOutputAtomically(output) {
  const temporaryPath = `${OUTPUT_PATH}.${process.pid}.${Date.now()}.tmp`;
  try {
    await writeFile(temporaryPath, output, 'utf-8');
    await rename(temporaryPath, OUTPUT_PATH);
  } catch (error) {
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
}

function createCatalog(modelsPayload, providersPayload) {
  if (!modelsPayload || typeof modelsPayload !== 'object' || Array.isArray(modelsPayload)) {
    throw new Error(`Unexpected ${MODELS_URL} response: expected an object keyed by canonical model ID`);
  }
  if (!providersPayload || typeof providersPayload !== 'object' || Array.isArray(providersPayload)) {
    throw new Error(`Unexpected ${PROVIDERS_URL} response: expected an object keyed by provider ID`);
  }
  const canonicalEntries = Object.entries(modelsPayload);
  const providerEntries = Object.entries(providersPayload);
  if (canonicalEntries.length < 100 || providerEntries.length < 50) {
    throw new Error('Models.dev response failed the catalog size sanity check');
  }
  if (!providersPayload[PREFERRED_PROVIDER]) {
    throw new Error(`${PROVIDERS_URL} does not contain the ${PREFERRED_PROVIDER} provider`);
  }

  const canonicalByModelId = new Map();
  for (const [canonicalId, model] of canonicalEntries) {
    if (!isModelMetadata(model)) throw new Error(`Invalid canonical model metadata for ${canonicalId}`);
    const separator = canonicalId.indexOf('/');
    if (separator < 1 || separator === canonicalId.length - 1) {
      throw new Error(`Invalid canonical model ID: ${canonicalId}`);
    }
    const providerId = normalize(canonicalId.slice(0, separator));
    const modelId = normalize(canonicalId.slice(separator + 1));
    addToIndex(canonicalByModelId, modelId, { providerId, canonicalId, model });
  }

  const providerModelsById = new Map();
  for (const [providerId, provider] of providerEntries) {
    if (!isModelMetadata(provider) || !isModelMetadata(provider.models)) {
      throw new Error(`Invalid provider metadata for ${providerId}`);
    }
    for (const [modelId, model] of Object.entries(provider.models)) {
      if (!isModelMetadata(model)) throw new Error(`Invalid model metadata for ${providerId}/${modelId}`);
      addToIndex(providerModelsById, normalize(modelId), {
        providerId: normalize(providerId),
        modelId,
        model,
      });
    }
  }

  return { canonicalByModelId, providerModelsById };
}

function isModelMetadata(value) {
  return value && typeof value === 'object' && !Array.isArray(value);
}

function addToIndex(index, key, value) {
  const entries = index.get(key);
  if (entries) entries.push(value);
  else index.set(key, [value]);
}

function updateRules(existingRules, catalog) {
  const changes = [];
  const warnings = [];
  let matchedKeys = 0;

  const generatedRules = existingRules.flatMap((rule) => {
    const entries = [];

    for (const key of rule.modelKeysIncludes) {
      const match = resolveModel(key, catalog);
      if (match) {
        entries.push(createUpdatedEntry(rule, key, match));
        matchedKeys += 1;
      } else {
        entries.push({
          key,
          contextSize: rule.contextSize,
          effortMap: rule.effortMap,
          warning: 'no exact Models.dev match',
        });
      }
    }

    const groups = groupEntries(entries);
    if (groups.length === 1) {
      const [group] = groups;
      const updated = buildRule(rule, group, rule.name);
      recordRuleChanges(rule, updated, changes);
      for (const warning of group.warnings) {
        warnings.push(`${rule.name ?? rule.modelKeysIncludes[0]}: ${warning}`);
      }
      return [updated];
    }

    const splitRules = groups.sort(compareGroupSpecificity).map((group) => {
      const label = group.entries.map((entry) => entry.key).join(', ');
      const baseName = getBaseRuleName(rule);
      const name = baseName ? `${baseName} (${label})` : undefined;
      for (const warning of group.warnings) warnings.push(`${name ?? label}: ${warning}`);
      return buildRule(rule, group, name);
    });
    changes.push({
      name: rule.name ?? rule.modelKeysIncludes[0],
      splitNames: splitRules.map((splitRule) => splitRule.name ?? splitRule.modelKeysIncludes.join(', ')),
    });
    return splitRules;
  });

  return { rules: orderRulesBySpecificity(generatedRules), changes, warnings, matchedKeys };
}

function orderRulesBySpecificity(rules) {
  const ordered = [];
  for (const rule of rules) {
    const insertAt = ordered.findIndex((existing) => isMoreSpecificRule(rule, existing));
    if (insertAt === -1) ordered.push(rule);
    else ordered.splice(insertAt, 0, rule);
  }
  return ordered;
}

function isMoreSpecificRule(candidate, existing) {
  return candidate.modelKeysIncludes.some((candidateKey) =>
    existing.modelKeysIncludes.some((existingKey) => {
      const candidateNormalized = normalize(candidateKey);
      const existingNormalized = normalize(existingKey);
      return candidateNormalized !== existingNormalized && candidateNormalized.includes(existingNormalized);
    }),
  );
}

function createUpdatedEntry(rule, key, match) {
  const effortResult = updateEffortMap(rule, [match]);
  return {
    key,
    contextSize: isPositiveInteger(match.context) ? formatContextSize(match.context) : rule.contextSize,
    effortMap: effortResult.effortMap ?? rule.effortMap,
    warning: effortResult.warning,
  };
}

function groupEntries(entries) {
  const groups = new Map();
  for (const entry of entries) {
    const signature = JSON.stringify({ contextSize: entry.contextSize, effortMap: entry.effortMap });
    let group = groups.get(signature);
    if (!group) {
      group = {
        contextSize: entry.contextSize,
        effortMap: entry.effortMap,
        entries: [],
        warnings: new Set(),
      };
      groups.set(signature, group);
    }
    group.entries.push(entry);
    if (entry.warning) group.warnings.add(entry.warning);
  }
  return [...groups.values()];
}

function compareGroupSpecificity(left, right) {
  return shortestKeyLength(right) - shortestKeyLength(left);
}

function shortestKeyLength(group) {
  return Math.min(...group.entries.map((entry) => normalize(entry.key).length));
}

function getBaseRuleName(rule) {
  if (!rule.name) return undefined;
  const generatedSuffix = ` (${rule.modelKeysIncludes.join(', ')})`;
  return rule.name.endsWith(generatedSuffix) ? rule.name.slice(0, -generatedSuffix.length) : rule.name;
}

function buildRule(rule, group, name) {
  const updated = {
    ...rule,
    modelKeysIncludes: group.entries.map((entry) => entry.key),
    contextSize: group.contextSize,
  };
  if (name === undefined) delete updated.name;
  else updated.name = name;
  if (group.effortMap !== undefined) updated.effortMap = group.effortMap;
  return updated;
}

function recordRuleChanges(rule, updated, changes) {
  const contextChanged = JSON.stringify(rule.contextSize) !== JSON.stringify(updated.contextSize);
  const effortChanged = JSON.stringify(rule.effortMap) !== JSON.stringify(updated.effortMap);
  if (!contextChanged && !effortChanged) return;
  changes.push({
    name: rule.name ?? rule.modelKeysIncludes[0],
    oldContext: rule.contextSize,
    newContext: updated.contextSize,
    contextChanged,
    effortChanged,
  });
}

function resolveModel(rawKey, catalog) {
  const key = normalize(rawKey);
  const canonical = chooseCanonicalModel(key, catalog.canonicalByModelId);
  const providerModel = chooseProviderModel(key, canonical?.providerId, catalog.providerModelsById);
  if (!canonical && !providerModel) return null;

  // OpenCode endpoint limits can be lower than the underlying canonical model.
  const contextSource = providerModel?.providerId === PREFERRED_PROVIDER ? providerModel.model : canonical?.model;
  const context = getContext(contextSource) ?? getContext(providerModel?.model);

  return {
    key: rawKey,
    context,
    reasoningOptions: providerModel?.model.reasoning_options,
    providerId: providerModel?.providerId,
  };
}

function chooseCanonicalModel(key, index) {
  const exact = index.get(key) ?? [];
  if (exact.length === 1) return exact[0];

  if (key.endsWith('-free')) {
    const withoutFree = index.get(key.slice(0, -'-free'.length)) ?? [];
    if (withoutFree.length === 1) return withoutFree[0];
  }
  return null;
}

function chooseProviderModel(key, canonicalProviderId, index) {
  const candidates = index.get(key) ?? [];
  if (candidates.length === 0) return null;
  const preferred = candidates.find((entry) => entry.providerId === PREFERRED_PROVIDER);
  if (preferred) return preferred;
  const canonicalProvider = candidates.find((entry) => entry.providerId === canonicalProviderId);
  if (canonicalProvider) return canonicalProvider;
  if (candidates.length === 1) return candidates[0];
  if (allEquivalent(candidates, (entry) => modelSignature(entry.model))) return candidates[0];
  return null;
}

function modelSignature(model) {
  return JSON.stringify({ context: getContext(model), reasoningOptions: model?.reasoning_options ?? null });
}

function allEquivalent(values, getSignature) {
  return new Set(values.map(getSignature)).size === 1;
}

function getContext(model) {
  const context = model?.limit?.context;
  return isPositiveInteger(context) ? context : null;
}

function isPositiveInteger(value) {
  return Number.isInteger(value) && value > 0;
}

function formatContextSize(tokens) {
  if (tokens >= 1_000_000) return `${trimDecimal(tokens / 1_000_000)}M`;
  if (tokens % 1000 === 0) return tokens / 1000;
  return `${trimDecimal(tokens / 1000)}K`;
}

function trimDecimal(value) {
  return value.toFixed(6).replace(/\.?0+$/, '');
}

function updateEffortMap(rule, matches) {
  if (rule.enableEffort === false || !rule.effortMap) return {};
  if (matches.some((match) => !Array.isArray(match.reasoningOptions))) {
    return { warning: 'reasoning_options are missing for one or more models; kept the existing effortMap' };
  }

  const configurations = matches.map((match) => parseReasoningOptions(match.reasoningOptions));
  if (configurations.some((configuration) => configuration.values.length === 0)) {
    return { warning: 'no explicit effort values are available for one or more models; kept the existing effortMap' };
  }
  if (!allEquivalent(configurations, (configuration) => JSON.stringify(configuration))) {
    return { warning: 'effort values differ between matched models; kept the existing effortMap' };
  }

  const configuration = configurations[0];
  const valuesByEffort = new Map();
  const representedValues = new Set();

  for (const effort of EFFORT_OPTIONS) {
    if (!Object.prototype.hasOwnProperty.call(rule.effortMap, effort)) continue;
    const mapped = rule.effortMap[effort];
    if (mapped === null && configuration.toggle) {
      valuesByEffort.set(effort, null);
      representedValues.add(effort);
    } else if (typeof mapped === 'string' && configuration.values.includes(mapped)) {
      valuesByEffort.set(effort, mapped);
      representedValues.add(mapped);
    }
  }

  for (const value of configuration.values) {
    if (!representedValues.has(value) && EFFORT_OPTIONS.includes(value)) {
      valuesByEffort.set(value, value);
      representedValues.add(value);
    }
  }

  const effortMap = Object.fromEntries(
    EFFORT_OPTIONS.filter((effort) => valuesByEffort.has(effort)).map((effort) => [effort, valuesByEffort.get(effort)]),
  );
  return Object.keys(effortMap).length > 0 ? { effortMap } : {};
}

function parseReasoningOptions(options) {
  const effort = options.find((option) => option?.type === 'effort' && Array.isArray(option.values));
  return {
    toggle: options.some((option) => option?.type === 'toggle'),
    values: [...new Set((effort?.values ?? []).filter((value) => typeof value === 'string'))],
  };
}

function normalize(value) {
  return value.trim().toLowerCase();
}

function countModelKeys(rules) {
  return rules.reduce((total, rule) => total + rule.modelKeysIncludes.length, 0);
}

function printSummary({ changes, warnings, matchedKeys, totalKeys, changed }) {
  console.log(`Models.dev matched ${matchedKeys}/${totalKeys} model keys.`);
  for (const change of changes) {
    if (change.splitNames) {
      console.log(`  ${change.name}: split into ${change.splitNames.length} rules`);
      for (const name of change.splitNames) console.log(`    - ${name}`);
      continue;
    }
    const details = [];
    if (change.contextChanged)
      details.push(`context ${JSON.stringify(change.oldContext)} -> ${JSON.stringify(change.newContext)}`);
    if (change.effortChanged) details.push('effortMap updated');
    console.log(`  ${change.name}: ${details.join(', ')}`);
  }
  for (const warning of warnings) console.warn(`  Warning: ${warning}`);
  if (changes.length === 0 && !changed) console.log('No rule changes found.');
}
