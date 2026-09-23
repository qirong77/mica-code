import { PROVIDER_PROTOCOLS, type ProviderDefinition, type ProviderProtocol } from './types.js';

/**
 * Codex-family harnesses (Terminal-Bench/Harbor, Multica, ...) authenticate by
 * exporting credentials as environment variables instead of writing a config
 * file, and a fresh task container only ever holds Mica's stock `deepseek`
 * provider with an empty `api_key`.
 *
 * Synthesize a runtime-only provider from the environment so such a driver can
 * pass `--model openai/<model>` verbatim. These providers are never written
 * back to config.json (see `stripRuntimeProviderFields`), and they are only
 * considered when no configured provider carries credentials at all, so a
 * developer shell that happens to export OPENAI_API_KEY cannot change how an
 * already-configured Mica behaves.
 */

type EnvProviderSpec = {
  id: string;
  name: string;
  apiKeyEnv: string;
  apiBaseEnv: string;
  defaultApiBase: string;
  defaultProtocol: ProviderProtocol;
};

const ENV_PROVIDER_SPECS: EnvProviderSpec[] = [
  {
    id: 'openai',
    name: 'OpenAI (environment)',
    apiKeyEnv: 'OPENAI_API_KEY',
    apiBaseEnv: 'OPENAI_BASE_URL',
    defaultApiBase: 'https://api.openai.com/v1',
    defaultProtocol: 'openai_responses',
  },
];

/** Provider ids that only exist for this process and must never be persisted. */
const envOnlyProviderIds = new Set<string>();

export function isEnvOnlyProvider(id: string): boolean {
  return envOnlyProviderIds.has(id);
}

/**
 * Returns `providers` with environment-derived providers prepended, or the
 * input unchanged when Mica already has a usable configuration.
 */
export function synthesizeEnvProviders(providers: ProviderDefinition[]): ProviderDefinition[] {
  envOnlyProviderIds.clear();
  if (providers.some((provider) => provider.api_key?.trim())) return providers;

  const synthesized: ProviderDefinition[] = [];
  for (const spec of ENV_PROVIDER_SPECS) {
    const apiKey = process.env[spec.apiKeyEnv]?.trim();
    if (!apiKey) continue;
    if (providers.some((provider) => provider.id === spec.id)) continue;
    synthesized.push({
      id: spec.id,
      name: spec.name,
      api_base: process.env[spec.apiBaseEnv]?.trim() || spec.defaultApiBase,
      api_key: apiKey,
      protocol: resolveEnvProtocol(spec.defaultProtocol),
    });
    envOnlyProviderIds.add(spec.id);
  }
  return synthesized.length > 0 ? [...synthesized, ...providers] : providers;
}

function resolveEnvProtocol(fallback: ProviderProtocol): ProviderProtocol {
  const override = process.env.MICA_PROVIDER_PROTOCOL?.trim();
  if (!override) return fallback;
  return (PROVIDER_PROTOCOLS as readonly string[]).includes(override)
    ? (override as ProviderProtocol)
    : fallback;
}
