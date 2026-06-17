import dotenv from "dotenv";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
dotenv.config({
  path: resolve(dirname(fileURLToPath(import.meta.url)), "../.env"),
});
import { OpenAIClient } from "../OpenAIClient.js";
import { writeFileSync } from "fs";

const client = new OpenAIClient(process.env.OPENAI_MODEL!);

client.onText = (t) => process.stdout.write(t);
client.onToolCall = (name, args) =>
  process.stdout.write(`\n\x1b[34m  >> ${name}(${args})\x1b[0m\n`);
client.onToolResult = (name, result) =>
  process.stdout.write(
    `\x1b[35m  << ${name}\x1b[0m \x1b[2m${result.slice(0, 120)}\x1b[0m\n`,
  );

const questions = ["你是谁", "你是什么模型", "介绍这个项目"];

for (const q of questions) {
  process.stdout.write(`\n\x1b[36mQ: ${q}\x1b[0m\n\x1b[33mA:\x1b[0m `);
  const response = await client.query(q);
  process.stdout.write(`\n\x1b[32m--- ${response}\x1b[0m\n`);
}

writeFileSync(
  "conversation_history.json",
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
    acc.input += r.tokens.input;
    acc.cachedInput += r.tokens.cached_input;
    acc.uncachedInput += r.tokens.uncached_input;
    acc.output += r.tokens.output;
    acc.total += r.tokens.total;
    return acc;
  },
  {
    input: 0,
    cachedInput: 0,
    uncachedInput: 0,
    output: 0,
    total: 0,
  },
);
const cacheHitRate = total.input > 0 ? total.cachedInput / total.input : 0;
console.log(`\n--- Token Summary ---`);
console.log(`Input tokens:      ${total.input}`);
console.log(`  uncached input:  ${total.uncachedInput}`);
console.log(`  cached input:    ${total.cachedInput}`);
console.log(`Output tokens:     ${total.output}`);
console.log(`Total tokens:      ${total.total}`);
console.log(`Cache hit rate:    ${(cacheHitRate * 100).toFixed(2)}%`);

const inputPer1M = Number(process.env.OPENAI_INPUT_PRICE_PER_1M);
const cachedInputPer1M = Number(process.env.OPENAI_CACHED_INPUT_PRICE_PER_1M);
const outputPer1M = Number(process.env.OPENAI_OUTPUT_PRICE_PER_1M);

if (
  process.env.OPENAI_INPUT_PRICE_PER_1M !== undefined &&
  process.env.OPENAI_CACHED_INPUT_PRICE_PER_1M !== undefined &&
  process.env.OPENAI_OUTPUT_PRICE_PER_1M !== undefined &&
  Number.isFinite(inputPer1M) &&
  Number.isFinite(cachedInputPer1M) &&
  Number.isFinite(outputPer1M)
) {
  const estimatedCost =
    (total.uncachedInput / 1_000_000) * inputPer1M +
    (total.cachedInput / 1_000_000) * cachedInputPer1M +
    (total.output / 1_000_000) * outputPer1M;
  console.log(`Estimated cost:    $${estimatedCost.toFixed(6)}`);
}
