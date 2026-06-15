import Anthropic from '@anthropic-ai/sdk';
import dotenv from 'dotenv';

dotenv.config({ override: true });

const ANTHROPIC_BASE_URL = 'https://api.krill-ai.com/codex';
// 从环境变量读取 AUTH_TOKEN，不再使用 apiKey
const ANTHROPIC_AUTH_TOKEN = process.env.ANTHROPIC_AUTH_TOKEN || '';

async function main(): Promise<void> {
  const client = new Anthropic({
    // 关键：使用 authToken 替代 apiKey
    authToken: ANTHROPIC_AUTH_TOKEN,
    baseURL: ANTHROPIC_BASE_URL,
  });

  console.log('开始测试 API 连通性...');

  const response = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 2048,
    thinking: { type: 'disabled' },
    messages: [
      {
        role: 'user',
        content: '你是什么模型？模型 ID 是多少？',
      },
    ],
  });

  const text = response.content
    .filter((block): block is Anthropic.TextBlock => block.type === 'text')
    .map((block) => block.text)
    .join('\n')
    .trim();

  console.log('连通性测试成功。');
  console.log(`response_id=${response.id}`);
  console.log(`response=${text || '[empty]'}`);
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`连通性测试失败: ${message}`);
  process.exit(1);
});