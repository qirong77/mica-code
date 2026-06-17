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
    `缓存锚点 ${String(index + 1).padStart(3, '0')}：Mica Code 是一个终端编程 agent 项目。这段共享上下文需要在每次请求中逐字节保持一致，以便 provider 端的 prompt 缓存能够复用这个长前缀。`,
).join('\n');

export const baseSystemPrompt = [
  '你是一个简洁的缓存测试助手。',
  '用不超过两句话回答用户的最终问题。',
  '以下重复的项目上下文是刻意保持稳定的，请求之间不得修改。',
  cacheAnchor,
].join('\n\n');

export const baseUserRequest = '请总结本次缓存实验验证的内容，并提及 cached_tokens。';

export function buildNonce(label: string, iteration: number): string {
  return `${label}-${iteration}-${randomUUID()}`;
}

export function stableSystemScenario(): CacheScenario {
  return {
    name: '稳定-system',
    description: 'system prompt 逐字节稳定不变，仅 user 消息中的迭代号递增。验证理想缓存命中效果。',
    buildMessages: (iteration) => ({
      system: baseSystemPrompt,
      user: `${baseUserRequest} 第 ${iteration} 轮。`,
    }),
  };
}

export function randomSystemPrefixScenario(): CacheScenario {
  return {
    name: '随机-system-前缀',
    description: 'system prompt 最前面插入随机 nonce，破坏前缀稳定性。预期缓存命中率为零。',
    buildMessages: (iteration) => ({
      system: `${buildNonce('system-前缀', iteration)}\n\n${baseSystemPrompt}`,
      user: `${baseUserRequest} 第 ${iteration} 轮。`,
    }),
  };
}

export function randomSystemSuffixScenario(): CacheScenario {
  return {
    name: '随机-system-后缀',
    description: 'system prompt 末尾追加随机 nonce，稳定部分仍在前面。验证后缀非稳定不影响前缀缓存命中。',
    buildMessages: (iteration) => ({
      system: `${baseSystemPrompt}\n\n${buildNonce('system-后缀', iteration)}`,
      user: `${baseUserRequest} 第 ${iteration} 轮。`,
    }),
  };
}

export function randomUserPrefixScenario(): CacheScenario {
  return {
    name: '随机-user-前缀',
    description: 'system prompt 稳定，user 消息前缀插入随机 nonce。验证 user 前缀变化是否影响 system 部分的缓存。',
    buildMessages: (iteration) => ({
      system: baseSystemPrompt,
      user: `${buildNonce('user-前缀', iteration)}\n\n${baseUserRequest} 第 ${iteration} 轮。`,
    }),
  };
}

export function formatUsage(usage: UsageLike | undefined): string {
  if (!usage) return '用量: 不可用';

  const promptTokens = usage.prompt_tokens ?? 0;
  const cachedTokens = usage.prompt_tokens_details?.cached_tokens ?? 0;
  const completionTokens = usage.completion_tokens ?? 0;
  const totalTokens = usage.total_tokens ?? promptTokens + completionTokens;
  const paidTokenRate = totalTokens > 0 ? Math.max(0, totalTokens - cachedTokens) / totalTokens : 0;

  return [
    `prompt tokens:   ${promptTokens}`,
    `output tokens:   ${completionTokens}`,
    `total tokens:    ${totalTokens}`,
    `付费占比:         ${(paidTokenRate * 100).toFixed(2)}%`,
  ].join('\n');
}

export function formatSummary(results: CacheResult[]): string {
  if (results.length === 0) return '没有收集到缓存结果。';

  const rows = results.map(({ scenario, iteration, usage }) => {
    const cachedTokens = usage?.prompt_tokens_details?.cached_tokens ?? 0;
    const promptTokens = usage?.prompt_tokens ?? 0;
    const completionTokens = usage?.completion_tokens ?? 0;
    const totalTokens = usage?.total_tokens ?? promptTokens + completionTokens;
    const paidTokenRate = totalTokens > 0 ? Math.max(0, totalTokens - cachedTokens) / totalTokens : 0;

    return `${scenario.padEnd(22)} #${String(iteration).padStart(2)}  total=${String(totalTokens).padStart(5)}  付费=${(paidTokenRate * 100).toFixed(2).padStart(6)}%`;
  });

  return ['汇总:', ...rows].join('\n');
}

export async function runScenario(scenario: CacheScenario, iterations = 4): Promise<CacheResult[]> {
  const results: CacheResult[] = [];

  console.log(`\n=== ${scenario.name} ===`);
  console.log(scenario.description);

  for (let iteration = 1; iteration <= iterations; iteration += 1) {
    const messages = scenario.buildMessages(iteration);

    console.log(`\n--- ${scenario.name} 第 ${iteration} 轮 ---`);
    console.log(messages.user.split('\n')[0]);
    process.stdout.write('\n回答: ');

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

    console.log(`\n\n缓存信息:\n${formatUsage(usage)}`);
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
