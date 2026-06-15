import OpenAI from 'openai';

type ChatResponse = Awaited<ReturnType<OpenAI['chat']['completions']['create']>>;
type UsageLike = ChatResponse['usage'];

const API_BASE = 'https://api.cdn-krill-ai.com/codex/v1';
const API_KEY = '';

const LONG_SYSTEM_PROMPT = `你是一个超严格的 AI 助手，需要始终遵守以下规则。

${Array.from({ length: 400 }, (_, i) => `规则 ${i + 1}：回答要准确、简洁、一致，并保持良好的结构化表达。`).join('\n')}

补充要求：
1. 如果问题可以直接回答，就不要兜圈子。
2. 如果信息不足，要明确说出缺失的信息。
3. 不要编造不存在的事实。
4. 输出尽量稳定，避免无意义改写。`;

function getCachedTokens(usage: UsageLike | undefined) {
  const promptTokensDetails = usage?.prompt_tokens_details;
  return promptTokensDetails?.cached_tokens;
}

function logResponse(label: string, response: ChatResponse) {
  const reply = response.choices[0]?.message?.content ?? '';
  const usage = response.usage;
  const promptTokensDetails = usage?.prompt_tokens_details;
  const completionTokensDetails = usage?.completion_tokens_details;
  const cachedTokens = getCachedTokens(usage);

  console.log(`\n--- ${label} ---`);
  console.log(`Assistant: ${reply.slice(0, 200)}`);
  console.log('usage:', JSON.stringify(usage, null, 2));
  console.log('prompt_tokens_details:', JSON.stringify(promptTokensDetails, null, 2));
  console.log('completion_tokens_details:', JSON.stringify(completionTokensDetails, null, 2));
  console.log('cached_tokens:', cachedTokens ?? 'N/A');
  console.log('response keys:', Object.keys(response));
}

async function main() {
  const client = new OpenAI({ baseURL: API_BASE, apiKey: API_KEY });
  const model = 'gpt-5.4';

  const messages = [
    { role: 'system', content: LONG_SYSTEM_PROMPT },
    {
      role: 'user',
      content:
        '请你只用一句话回答：什么是缓存命中？另外不要重复 system prompt 的内容，也不要输出多余说明。',
    },
  ] satisfies Array<{ role: 'system' | 'user'; content: string }>;

  const req = {
    model,
    messages,
    max_tokens: 128,
    temperature: 0,
  };

  console.log('system prompt length:', LONG_SYSTEM_PROMPT.length);
  console.log('request message count:', messages.length);
  console.log('sending same request twice to detect prompt caching');

  const response1 = await client.chat.completions.create(req);
  logResponse('Request 1', response1);

  const response2 = await client.chat.completions.create(req);
  logResponse('Request 2', response2);

  console.log('\n=== Cache Comparison ===');
  console.log('request_1_cached_tokens:', getCachedTokens(response1.usage) ?? 'N/A');
  console.log('request_2_cached_tokens:', getCachedTokens(response2.usage) ?? 'N/A');
  console.log('same_system_prompt:', true);
  console.log('same_user_prompt:', true);
  console.log('prompt_tokens_1:', response1.usage?.prompt_tokens ?? 'N/A');
  console.log('prompt_tokens_2:', response2.usage?.prompt_tokens ?? 'N/A');
}

void main().catch((err: unknown) => {
  console.error('Error:', err instanceof Error ? err.message : String(err));
});
