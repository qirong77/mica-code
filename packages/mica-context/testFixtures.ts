import type { AssistantMessage, ImageContent, Message, TextContent, ToolCall, ToolResultMessage, UserMessage, Usage } from '@earendil-works/pi-ai';

export const FIXTURE_TIMESTAMP = 1_700_000_000_000;
export const IMAGE_BASE64 = 'QUJD'.repeat(400);

export function usage(): Usage {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
}

export function text(text: string): TextContent {
  return { type: 'text', text };
}

export function image(data = IMAGE_BASE64): ImageContent {
  return { type: 'image', data, mimeType: 'image/png' };
}

export function user(content: UserMessage['content'], timestamp = FIXTURE_TIMESTAMP): UserMessage {
  return { role: 'user', content, timestamp };
}

export function assistant(content: string | AssistantMessage['content'], overrides: Partial<AssistantMessage> = {}): AssistantMessage {
  return {
    role: 'assistant', content: typeof content === 'string' ? [text(content)] : content,
    api: 'openai-responses', provider: 'test', model: 'test-model', usage: usage(),
    stopReason: 'stop', timestamp: FIXTURE_TIMESTAMP, ...overrides,
  };
}

export function toolCall(id: string, name: string, args: ToolCall['arguments'] = {}): ToolCall {
  return { type: 'toolCall', id, name, arguments: args };
}

export function toolResult(id: string, name: string, content: string | ToolResultMessage['content'], isError = false): ToolResultMessage {
  return {
    role: 'toolResult', toolCallId: id, toolName: name,
    content: typeof content === 'string' ? [text(content)] : content, isError, timestamp: FIXTURE_TIMESTAMP,
  };
}

export function toolBatch(id: string, name = 'read_file', output = 'result '.repeat(1000)): Message[] {
  return [assistant([toolCall(id, name, { path: `src/${id}.ts` })], { stopReason: 'toolUse' }), toolResult(id, name, output)];
}

export function makeMessages(rounds: number, offset = 0): Message[] {
  return Array.from({ length: rounds }, (_, index) => index + 1 + offset).flatMap((turn) => [
    user(`user request ${turn}`), assistant(`assistant answer ${turn}\nfile packages/example${turn}.ts`),
  ]);
}

export function makeToolMessages(rounds: number): Message[] {
  return Array.from({ length: rounds }, (_, index) => index + 1).flatMap((turn) => [
    user([text(`user request ${turn}`), image()]),
    assistant([text(`assistant answer ${turn}`), toolCall(`read-${turn}`, 'read_file', { path: `packages/example${turn}.ts` })], { stopReason: 'toolUse' }),
    toolResult(`read-${turn}`, 'read_file', `RAW_TOOL_RESULT_${turn}: ${'x'.repeat(4000)}`),
    assistant([toolCall(`shell-${turn}`, 'run_shell', { command: `cat packages/example${turn}.ts` })], { stopReason: 'toolUse' }),
    toolResult(`shell-${turn}`, 'run_shell', `RAW_SHELL_RESULT_${turn}: ${'y'.repeat(4000)}`),
  ]);
}
