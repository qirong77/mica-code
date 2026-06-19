// prompt 缓存策略对比实验
// 核心结论：前缀稳定 = 缓存命中；前缀插入随机内容 = 缓存失效。
// 运行：bun run packages/mica-agent/examples/openai-cache-tests/index.ts

import dotenv from 'dotenv';
import { randomUUID } from 'crypto';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { OpenAI } from 'openai';

dotenv.config({
  path: resolve(dirname(fileURLToPath(import.meta.url)), '../../.env'),
});

const configuredModel = process.env.OPENAI_MODEL;
if (!configuredModel) throw new Error('OPENAI_MODEL is required');
const model: string = configuredModel;

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
  baseURL: process.env.OPENAI_BASE_URL,
});

type Usage = {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number };
};

type Scenario = {
  name: string;
  build: (i: number) => { system: string; user: string };
};

const anchor = Array.from(
  { length: 180 },
  (_, i) =>
    `缓存锚点 ${String(i + 1).padStart(3, '0')}：Mica Code 是一个终端编程 agent 项目。此上下文逐字节稳定以便 provider 复用缓存前缀。`,
).join('\n');

const system = [
  '你是缓存测试助手，用不超过两句话回答。',
  anchor,
].join('\n\n');

const question = '请总结本次缓存实验验证的内容，并提及 cached_tokens。';

function nonce(label: string, i: number) {
  return `${label}-${i}-${randomUUID()}`;
}

const scenarios: Scenario[] = [
  {
    name: '稳定-system          ',
    build: (i) => ({ system, user: `${question} 第 ${i} 轮。` }),
  },
  {
    name: '随机-system-前缀     ',
    build: (i) => ({ system: `${nonce('前缀', i)}\n\n${system}`, user: `${question} 第 ${i} 轮。` }),
  },
  {
    name: '随机-system-后缀     ',
    build: (i) => ({ system: `${system}\n\n${nonce('后缀', i)}`, user: `${question} 第 ${i} 轮。` }),
  },
  {
    name: '随机-user-前缀       ',
    build: (i) => ({ system, user: `${nonce('user', i)}\n\n${question} 第 ${i} 轮。` }),
  },
];

async function run(iterations = 4) {
  console.log(`\n模型: ${model}`);
  console.log(`每场景 ${iterations} 轮\n`);

  const rows: string[] = [];

  for (const s of scenarios) {
    for (let i = 1; i <= iterations; i++) {
      const msg = s.build(i);
      let usage: Usage | undefined;

      const stream = await client.chat.completions.create({
        model,
        messages: [
          { role: 'system', content: msg.system },
          { role: 'user', content: msg.user },
        ],
        stream: true,
        stream_options: { include_usage: true },
      });

      process.stdout.write(`${s.name.trim()} #${i}: `);
      for await (const chunk of stream) {
        if (chunk.choices[0]?.delta?.content) process.stdout.write(chunk.choices[0].delta.content);
        if (chunk.usage) usage = chunk.usage;
      }

      const total = usage?.total_tokens ?? 0;
      const cached = usage?.prompt_tokens_details?.cached_tokens ?? 0;
      const rate = total > 0 ? ((total - cached) / total * 100).toFixed(1) : '0.0';
      rows.push(`${s.name} #${i}  total=${String(total).padStart(5)}  付费=${rate.padStart(5)}%`);
      console.log();
    }
  }

  console.log(`\n======== 结论 ========`);
  console.log(rows.join('\n'));
  console.log(`\n付费占比越低 = 缓存命中越多 = 越省钱`);
}

run();