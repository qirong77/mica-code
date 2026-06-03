# 绕过 partial-json-parser：修复长内容工具调用的截断问题

## 问题现象

当 AI 模型调用 `write_file` 工具写入超长内容时（数百行 Markdown），偶尔出现：

```
TypeError: The "data" argument must be of type string or an instance of Buffer, TypedArray, or DataView
```

错误来自 `fs.writeFile(path, undefined)` ——工具收到的 `content` 参数丢失了。但短内容写入从未出问题。

## 追踪调用链

完整链路如下：

```
AI 模型生成 tool call JSON（含长 content 字符串）
  → Anthropic API SSE 流式推送 input_json_delta 片段
    → MessageStream._accumulateMessage 累计 jsonBuf
      → 每个 delta 调用 partialParse(jsonBuf)
        → JSON.parse(generate(unstrip(strip(tokenize(input)))))
    → content_block_stop 时 emit contentBlock(content.input)
  → iteration-runner.ts:79: content.input as Record<string, any>
    → ToolWriteFile.execute(input.file_path, input.content)
      → writeFile(path, undefined) 💥
```

根因定位在 `MessageStream.mjs` 使用的 `partial-json-parser`（`_vendor/partial-json-parser/parser.mjs`）：

```javascript
// 字符串 tokenizer 的核心逻辑
if (char === '"') {
    let danglingQuote = false;
    while (char !== '"') {
        if (current === input.length) {
            danglingQuote = true;  // 读到 buffer 末尾还没找到闭合引号
            break;
        }
        value += char;
        char = input[++current];
    }
    if (!danglingQuote) {
        tokens.push({ type: 'string', value });  // 只有完整字符串才入 token 列表
    }
    // 悬空字符串：直接丢弃，不产生任何 token
}
```

当 API 的 SSE 流被 `max_tokens` 截断在长字符串中间时（如 `"content": "非常长的内容...（截断）`），这个字符串的闭合引号还没到，`danglingQuote = true`，整个 key-value 对被丢弃。最终 `partialParse` 返回 `{ file_path: "/path" }`，没有 `content` 字段。

这不是 bug——流式解析中未闭合的字符串本就是不可靠的。问题出在上游没有对截断后的残缺 input 做防御。

## claude-code-main 的做法

参考了 `claude-code-main/src/services/api/claude.ts:1898-1900` 的注释：

```typescript
// Use raw stream instead of BetaMessageStream to avoid O(n²) partial JSON parsing
// BetaMessageStream calls partialParse() on every input_json_delta, which we don't need
// since we handle tool input accumulation ourselves
```

claude-code-main 完全不用 `MessageStream`，而是直接消费原始 `Stream<RawMessageStreamEvent>`：

```typescript
// content_block_start: 初始化为空字符串
contentBlocks[part.index] = { ...part.content_block, input: '' };

// input_json_delta: 只做字符串拼接
contentBlock.input += delta.partial_json;

// content_block_stop: 一次性 JSON.parse
const toolInput = JSON.parse(contentBlock.input);
```

这个方案彻底绕过了 `partial-json-parser` 的字符串丢弃问题。即使 `max_tokens` 截断，`content_block_stop` 时拿到的是完整 JSON 片段（可能缺尾部内容但不会丢字段名）。

此外，claude-code-main 每个工具都有 `validateInput` 方法（`Tool.ts:510`），在工具执行前校验必需参数：

```typescript
const isValidCall = await tool.validateInput?.(parsedInput.data, toolUseContext);
if (isValidCall?.result === false) {
    return [{ type: 'tool_result', is_error: true, content: `<tool_use_error>${isValidCall.message}</tool_use_error>` }];
}
```

校验失败时返回带 `is_error: true` 的 `tool_result`，模型能看到明确错误并重试。而 mica-code 之前的做法是直接让 `writeFile(undefined)` 抛出 Node.js 底层错误，模型收到的只有一行难以理解的异常信息。

## 实现方案

在 mica-code 中实现了两层修复：

### 第一层：RawStreamProcessor 替代 MessageStream

新增 `src/agent/raw-stream-processor.ts`，直接消费 SDK 原始 `Stream<RawMessageStreamEvent>`：

- `content_block_start`：记录工具名/id，初始化 `inputRaw = ''`
- `input_json_delta`：**只做字符串拼接** `inputRaw += delta.partial_json`
- `content_block_stop`：**一次性 `JSON.parse(inputRaw)`**，然后 emit `contentBlock` 事件
- 同时 emit `text`/`thinking` 事件，保持与 `agentEvents.ts` 的兼容

`iteration-runner.ts` 改为调用 `client.messages.create({ ...params, stream: true })` 获取原始 Stream，通过 `RawStreamProcessor` 处理。

### 第二层：工具入口 validateInput

在 `MicaTool.ts` 基类新增 `validateInput` 方法：

```typescript
validateInput(input: Record<string, any>): ValidationResult {
    const required = (this.input_schema.required as string[]) || [];
    for (const key of required) {
        if (!(key in input) || input[key] === undefined) {
            return { valid: false, message: `缺少必需参数 ${key}` };
        }
        const prop = this.input_schema.properties?.[key];
        if (prop?.type === 'string' && typeof input[key] !== 'string') {
            return { valid: false, message: `参数 ${key} 应为 string 类型` };
        }
    }
    return { valid: true };
}
```

在 `executeTool`（`tools/index.ts`）中，**执行前**调用 `validateInput`。校验失败时返回中文错误信息，模型能据此重试或调整策略。

### 第三层：ToolWriteFile 的防御性校验

之前已在 `ToolWriteFile.execute()` 入口添加了 `typeof input.content !== 'string'` 检查，防止 `undefined` 透传到 `fs.writeFile`。

## 对比

| 方案 | 改动文件 | 防御层级 |
|------|----------|----------|
| RawStreamProcessor | +1 新文件，改 iteration-runner.ts | 根因修复，彻底避开 partialParse |
| validateInput | 改 MicaTool.ts + tools/index.ts | 执行前校验，残缺 input 不进 execute |
| ToolWriteFile 校验 | 改 ToolWriteFile.ts | 最后防线，阻止 undefined → writeFile |

三层从不同深度拦截：stream 层保证 input 完整性 → 工具注册层校验 schema → execute 层做类型守卫。即使某一层没有覆盖到位，下一层仍能兜底。

## 教训

1. **流式解析器是脆弱的边界**：partial-json-parser 对未闭合字符串的"静默丢弃"在 99% 情况下合理，但被 max_tokens 截断击中时会产生难以排查的连锁故障
2. **参考成熟项目比闭门造车快**：claude-code-main 的注释直接说明"BetaMessageStream 的 partialParse 是我们不需要的"，说明他们也踩过这个坑
3. **工具输入校验应该是架构级别的基础设施**：不是每个工具各写各的，而是基类定义、框架自动调用，确保所有工具都受益
