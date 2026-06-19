import dotenv from 'dotenv';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
dotenv.config({
  path: resolve(dirname(fileURLToPath(import.meta.url)), '../.env'),
});
import { OpenAIClient } from '../providers/OpenAIClient.js';
import { writeFileSync } from 'fs';

const client = new OpenAIClient(process.env.OPENAI_MODEL!);

client.onText = (t) => process.stdout.write(t);
client.onToolCall = (name, args) => process.stdout.write(`\n\x1b[34m  >> ${name}(${args})\x1b[0m\n`);
client.onToolResult = (name, result) =>
  process.stdout.write(`\x1b[35m  << ${name}\x1b[0m \x1b[2m${result.slice(0, 120)}\x1b[0m\n`);

const questions = ['你是谁', '你是什么模型', '介绍这个项目'];

for (const q of questions) {
  process.stdout.write(`\n\x1b[36mQ: ${q}\x1b[0m\n\x1b[33mA:\x1b[0m `);
  const response = await client.query(q);
  process.stdout.write(`\n\x1b[32m--- ${response}\x1b[0m\n`);
}

writeFileSync(
  'conversation_history.json',
  JSON.stringify(
    {
      messages: client.messages,
      usage: client.usageHistory,
    },
    null,
    2,
  ),
);

const total = client.usageHistory.reduce(
  (acc, r) => {
    acc.input += r.inputTokens;
    acc.output += r.outputTokens;
    acc.total += r.totalTokens;
    acc.paidWeighted += r.paidTokenRate * r.totalTokens;
    return acc;
  },
  {
    input: 0,
    output: 0,
    total: 0,
    paidWeighted: 0,
  },
);
const paidTokenRate = total.total > 0 ? total.paidWeighted / total.total : 0;
console.log(`\n--- Token Summary ---`);
console.log(`Input tokens:      ${total.input}`);
console.log(`Output tokens:     ${total.output}`);
console.log(`Total tokens:      ${total.total}`);
console.log(`Paid token rate:   ${(paidTokenRate * 100).toFixed(2)}%`);
