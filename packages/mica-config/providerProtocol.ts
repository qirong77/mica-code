/** Public configuration names; Pi API names are translated by the model client. */
export const PROVIDER_PROTOCOLS = [
  'openai_chat_completions',
  'openai_responses',
  'anthropic_messages',
  'google_generative_ai',
] as const;

export type ProviderProtocol = (typeof PROVIDER_PROTOCOLS)[number];

export function isProviderProtocol(value: unknown): value is ProviderProtocol {
  return typeof value === 'string' && PROVIDER_PROTOCOLS.includes(value as ProviderProtocol);
}
