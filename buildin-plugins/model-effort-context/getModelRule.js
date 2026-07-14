const MODELS_URL = 'https://models.dev/api.json';
const EFFORTS = ['none', 'low', 'medium', 'high', 'xhigh'];

let modelsRequest;

/**
 * Look up a model on models.dev and turn its metadata into a mica model rule.
 *
 * A model often occurs under several gateways in api.json.  The first choice is
 * therefore the model author's provider; if that cannot be inferred, the most
 * common definition among exact-name matches is used.
 */
export async function getModelRule(modelName = '', signal) {
  const requestedName = modelName.trim();
  if (!requestedName) throw new TypeError('modelName must be a non-empty string');

  const providers = await loadModels(signal);
  const matches = findMatches(providers, requestedName);
  if (matches.length === 0) throw new Error(`Model not found on models.dev: ${requestedName}`);

  const match = selectMatch(matches, requestedName);
  const contextSize = match.model?.limit?.context;
  if (!Number.isFinite(contextSize) || contextSize <= 0) {
    throw new Error(`Model has no valid context limit on models.dev: ${requestedName}`);
  }

  const options = Array.isArray(match.model.reasoning_options) ? match.model.reasoning_options : [];
  const effortOption = options.find((option) => option?.type === 'effort');
  const hasToggle = options.some((option) => option?.type === 'toggle');
  const efforts = normalizeEfforts(effortOption?.values, hasToggle, match.model.reasoning);
  const protocol = match.providerId === 'openai' ? 'openai_responses' : 'openai_chat_completions';

  return {
    contextSize,
    defaultEffort: chooseDefaultEffort(efforts, protocol),
    efforts: Object.fromEntries(
      efforts.map((effort) => [
        effort,
        { [protocol]: requestPatch(protocol, effort, hasToggle, Boolean(effortOption)) },
      ]),
    ),
  };
}

async function loadModels(signal) {
  const requestSignal = signal ? AbortSignal.any([signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000);
  modelsRequest ??= fetch(MODELS_URL, { signal: requestSignal }).then(async (response) => {
    if (!response.ok) throw new Error(`models.dev request failed: ${response.status} ${response.statusText}`);
    return response.json();
  });

  try {
    return await modelsRequest;
  } catch (error) {
    modelsRequest = undefined;
    throw error;
  }
}

function findMatches(providers, requestedName) {
  const basename = requestedName.split('/').at(-1).toLowerCase();
  const exact = [];
  const basenameMatches = [];

  for (const [providerId, provider] of Object.entries(providers ?? {})) {
    for (const [key, model] of Object.entries(provider?.models ?? {})) {
      const ids = [key, model?.id].filter((value) => typeof value === 'string');
      const candidate = { providerId, model };
      if (ids.some((id) => id.toLowerCase() === requestedName.toLowerCase())) exact.push(candidate);
      if (ids.some((id) => id.split('/').at(-1).toLowerCase() === basename)) basenameMatches.push(candidate);
    }
  }

  return exact.length > 0 ? exact : basenameMatches;
}

function selectMatch(matches, modelName) {
  const owner = inferOwner(modelName);
  const original = owner && matches.find((match) => match.providerId === owner);
  if (original) return original;

  const signatureCounts = new Map();
  for (const match of matches) {
    const signature = JSON.stringify({
      context: match.model?.limit?.context,
      reasoning: match.model?.reasoning,
      options: normalizeOptionSignature(match.model?.reasoning_options),
    });
    signatureCounts.set(signature, (signatureCounts.get(signature) ?? 0) + 1);
  }
  return matches.reduce((best, match) =>
    signatureCount(match, signatureCounts) > signatureCount(best, signatureCounts) ? match : best,
  );
}

function inferOwner(modelName) {
  const name = modelName.toLowerCase();
  if (/(^|\/)gpt-|(^|\/)o[134](?:-|$)/.test(name)) return 'openai';
  if (/(^|\/)grok-/.test(name)) return 'xai';
  if (/(^|\/)(kimi-|moonshot)/.test(name)) return 'moonshotai';
  if (/(^|\/)deepseek-/.test(name)) return 'deepseek';
  if (/(^|\/)claude-/.test(name)) return 'anthropic';
  if (/(^|\/)gemini-/.test(name)) return 'google';
  return undefined;
}

function normalizeOptionSignature(options) {
  return (Array.isArray(options) ? options : []).map((option) => ({
    type: option?.type,
    values: Array.isArray(option?.values) ? option.values.map(normalizeEffortName).sort() : undefined,
  }));
}

function signatureCount(match, counts) {
  return counts.get(
    JSON.stringify({
      context: match.model?.limit?.context,
      reasoning: match.model?.reasoning,
      options: normalizeOptionSignature(match.model?.reasoning_options),
    }),
  );
}

function normalizeEfforts(values, hasToggle, supportsReasoning) {
  const result = (Array.isArray(values) ? values : [])
    .map(normalizeEffortName)
    .filter((value) => EFFORTS.includes(value));
  if (hasToggle && !result.includes('none')) result.unshift('none');
  if (hasToggle && result.length === 1) result.push('high');
  if (result.length === 0 && supportsReasoning) result.push('high');
  return [...new Set(result)].sort((left, right) => EFFORTS.indexOf(left) - EFFORTS.indexOf(right));
}

function normalizeEffortName(value) {
  return value === 'max' ? 'xhigh' : value;
}

function chooseDefaultEffort(efforts, protocol) {
  if (protocol === 'openai_responses' && efforts.includes('medium')) return 'medium';
  if (efforts.includes('high')) return 'high';
  if (efforts.includes('medium')) return 'medium';
  return efforts.at(-1) ?? 'none';
}

function requestPatch(protocol, effort, hasToggle, hasEffort) {
  if (protocol === 'openai_responses') return { reasoning: { effort } };
  if (hasToggle) {
    const patch = { thinking: { type: effort === 'none' ? 'disabled' : 'enabled' } };
    if (effort !== 'none' && hasEffort) patch.reasoning_effort = effort === 'xhigh' ? 'max' : effort;
    return patch;
  }
  return { reasoning_effort: effort === 'xhigh' ? 'max' : effort };
}
