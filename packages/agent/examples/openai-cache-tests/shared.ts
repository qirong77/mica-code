import dotenv from 'dotenv';
import { randomUUID } from 'crypto';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { OpenAI } from 'openai';

dotenv.config({
  path: resolve(dirname(fileURLToPath(import.meta.url)), '../../.env'),
});

const configuredModel = process.env.OPENAI_MODEL;

if (!configuredModel) {
  throw new Error('OPENAI_MODEL is required');
}

const model: string = configuredModel;

export type UsageLike = {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  prompt_tokens_details?: {
    cached_tokens?: number;
  };
};

export type CacheScenario = {
  name: string;
  description: string;
  buildMessages: (iteration: number) => {
    system: string;
    user: string;
  };
};

export type CacheResult = {
  scenario: string;
  iteration: number;
  usage: UsageLike | undefined;
};

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
  baseURL: process.env.OPENAI_BASE_URL,
});

export const cacheAnchor = Array.from(
  { length: 180 },
  (_, index) =>
    `Cache anchor ${String(index + 1).padStart(3, '0')}: Mica Code is a terminal coding agent project. Keep this shared context byte-for-byte stable across requests so provider-side prompt caching can reuse the long prefix.`,
).join('\n');

export const baseSystemPrompt = [
  'You are a concise cache test assistant.',
  "Answer the user's final question in no more than two short sentences.",
  'The following repeated project context is intentionally stable and must not be changed between requests.',
  cacheAnchor,
].join('\n\n');

export const baseUserRequest = 'Summarize what this cache experiment is checking, and mention cached_tokens.';

export function buildNonce(label: string, iteration: number): string {
  return `${label}-${iteration}-${randomUUID()}`;
}

export function stableSystemScenario(): CacheScenario {
  return {
    name: 'stable-system',
    description: 'The system prompt is byte-for-byte stable; only the iteration number in the user request changes.',
    buildMessages: (iteration) => ({
      system: baseSystemPrompt,
      user: `${baseUserRequest} Iteration ${iteration}.`,
    }),
  };
}

export function randomSystemPrefixScenario(): CacheScenario {
  return {
    name: 'random-system-prefix',
    description: 'A random nonce is inserted at the very beginning of the system prompt on every request.',
    buildMessages: (iteration) => ({
      system: `${buildNonce('system-prefix', iteration)}\n\n${baseSystemPrompt}`,
      user: `${baseUserRequest} Iteration ${iteration}.`,
    }),
  };
}

export function randomSystemSuffixScenario(): CacheScenario {
  return {
    name: 'random-system-suffix',
    description: 'The stable system prompt stays first, and a random nonce is appended at the end on every request.',
    buildMessages: (iteration) => ({
      system: `${baseSystemPrompt}\n\n${buildNonce('system-suffix', iteration)}`,
      user: `${baseUserRequest} Iteration ${iteration}.`,
    }),
  };
}

export function randomUserPrefixScenario(): CacheScenario {
  return {
    name: 'random-user-prefix',
    description: 'The system prompt is stable, and a random nonce is inserted at the beginning of the user message.',
    buildMessages: (iteration) => ({
      system: baseSystemPrompt,
      user: `${buildNonce('user-prefix', iteration)}\n\n${baseUserRequest} Iteration ${iteration}.`,
    }),
  };
}

export function formatUsage(usage: UsageLike | undefined): string {
  if (!usage) return 'usage: unavailable';

  const promptTokens = usage.prompt_tokens ?? 0;
  const cachedTokens = usage.prompt_tokens_details?.cached_tokens ?? 0;
  const completionTokens = usage.completion_tokens ?? 0;
  const totalTokens = usage.total_tokens ?? promptTokens + completionTokens;
  const paidTokenRate = totalTokens > 0 ? Math.max(0, totalTokens - cachedTokens) / totalTokens : 0;

  return [
    `prompt tokens:   ${promptTokens}`,
    `output tokens:   ${completionTokens}`,
    `total tokens:    ${totalTokens}`,
    `paid token rate: ${(paidTokenRate * 100).toFixed(2)}%`,
  ].join('\n');
}

export function formatSummary(results: CacheResult[]): string {
  if (results.length === 0) return 'No cache results collected.';

  const rows = results.map(({ scenario, iteration, usage }) => {
    const cachedTokens = usage?.prompt_tokens_details?.cached_tokens ?? 0;
    const promptTokens = usage?.prompt_tokens ?? 0;
    const completionTokens = usage?.completion_tokens ?? 0;
    const totalTokens = usage?.total_tokens ?? promptTokens + completionTokens;
    const paidTokenRate = totalTokens > 0 ? Math.max(0, totalTokens - cachedTokens) / totalTokens : 0;

    return `${scenario.padEnd(22)} #${String(iteration).padStart(2)}  total=${String(totalTokens).padStart(5)}  paid=${(paidTokenRate * 100).toFixed(2).padStart(6)}%`;
  });

  return ['Summary:', ...rows].join('\n');
}

export async function runScenario(scenario: CacheScenario, iterations = 4): Promise<CacheResult[]> {
  const results: CacheResult[] = [];

  console.log(`\n=== ${scenario.name} ===`);
  console.log(scenario.description);

  for (let iteration = 1; iteration <= iterations; iteration += 1) {
    const messages = scenario.buildMessages(iteration);

    console.log(`\n--- ${scenario.name} request ${iteration} ---`);
    console.log(messages.user.split('\n')[0]);
    process.stdout.write('\nAnswer: ');

    let usage: UsageLike | undefined;
    const stream = await client.chat.completions.create({
      model,
      messages: [
        { role: 'system', content: messages.system },
        { role: 'user', content: messages.user },
      ],
      stream: true,
      stream_options: {
        include_usage: true,
      },
    });

    for await (const chunk of stream) {
      const content = chunk.choices[0]?.delta?.content;
      if (content) process.stdout.write(content);
      if (chunk.usage) usage = chunk.usage;
    }

    results.push({
      scenario: scenario.name,
      iteration,
      usage,
    });

    console.log(`\n\nCache info:\n${formatUsage(usage)}`);
  }

  return results;
}

export async function runComparison(title: string, scenarios: CacheScenario[], iterations = 4): Promise<void> {
  console.log(`\n# ${title}`);
  console.log(`Model: ${model}`);
  console.log(`Iterations per scenario: ${iterations}`);

  const results: CacheResult[] = [];

  for (const scenario of scenarios) {
    results.push(...(await runScenario(scenario, iterations)));
  }

  console.log(`\n${formatSummary(results)}`);
}
