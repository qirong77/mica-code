# Compact 策略方案（已完成基础版）

`compact(messages)` 是一次上下文检查点压缩操作。它的目标不是机械地缩短文本，而是把一段包含工具调用、工具结果和多轮对话的原始历史，转换成一个紧凑、可信、可继续执行的任务交接状态。

压缩后的上下文应该让下一个 coding agent 能够继续同一个任务，而不需要重新读取完整原始会话。

## 输入与输出

输入：

```ts
compact(messages: ConversationItem[]): Promise<CompactResult>
```

输入应该是 provider 无关的 canonical message。它可以包含用户消息、助手消息、工具调用、工具结果、系统消息，以及无法识别的 provider 特定消息。

输出：

```ts
{
  messages: [checkpointMessage],
  summary,
  beforeCount,
  afterCount,
  beforeTokenEstimate,
  afterTokenEstimate,
}
```

输出后的活跃上下文通常只保留一条 checkpoint message。原始工具调用历史不应该继续留在模型上下文中。

## 处理顺序

### 1. 校验输入

以下情况直接拒绝或 no-op：

- messages 为空。
- 内容太少，没有压缩价值。
- 当前对话只包含已有 compact checkpoint。

如果历史中已经存在 compact checkpoint 或 compact boundary，应先从本次总结输入中移除，避免“总结的总结”不断递归膨胀。

### 2. 统一 Provider 消息格式

Compact 不应该依赖 OpenAI、Anthropic、Gemini 等 provider 的原始消息结构。

各 provider adapter 应先把原始消息转换为统一结构：

```ts
type ConversationItem =
  | { type: 'system'; content: ContentBlock[] }
  | { type: 'user'; content: ContentBlock[] }
  | { type: 'assistant'; content: ContentBlock[] }
  | { type: 'tool_call'; id: string; name: string; args: unknown; argsText?: string; precedingAssistantText?: string }
  | { type: 'tool_result'; id: string; name?: string; content: string; isError?: boolean }
  | { type: 'unknown'; role?: string; content: unknown };
```

Provider 转换规则：

- OpenAI assistant message 中的 `tool_calls` 转为 `tool_call`。
- OpenAI `role: "tool"` message 转为 `tool_result`。
- Anthropic `tool_use` block 转为 `tool_call`。
- Anthropic `tool_result` block 转为 `tool_result`。
- JSON 参数解析失败时不能丢数据，要保留原始参数字符串。
- 找不到对应 tool call 的 orphan tool result 也不能丢弃，应保留为未知工具名的 `tool_result`。

### 3. 只保留事实，不推断隐藏意图

工具调用只能记录可观测事实：

- 工具名
- 参数
- 调用 id
- 调用前 assistant 已经输出的文本，如果有
- 工具结果
- 是否错误

不要推断 assistant 的隐藏意图。

可以这样记录：

```text
Tool call: read_file
Arguments: { "file_path": "src/session/SessionController.ts" }
Observed action: read src/session/SessionController.ts.
Preceding assistant text: "I will inspect session restore logic."
```

除非前文明确说过，否则不要写：

```text
Intent: understand why resume is broken.
```

核心原则：compact 阶段总结证据，不读心。

### 4. 转换为总结用 Transcript

Summarizer 不应该直接读取 provider 原始 JSON，而应该读取结构化 transcript。

推荐格式：

```text
## Message 12 - user
...

## Message 13 - assistant
...

## Tool Call 14
id: call_x
name: read_file
arguments:
{ ... }
preceding_assistant_text: ...

## Tool Result 15
id: call_x
name: read_file
is_error: false
content_summary:
...
```

这样工具历史既可读，又不绑定具体 provider。

### 5. 移除 UI 噪声

可以丢弃纯展示状态、不会影响后续任务的信息，例如：

- spinner
- loading 文案
- 空 assistant delta
- 流式输出进度标记
- panel/status 状态更新
- 只有 ANSI 控制字符或空白的内容
- “工具开始/工具结束”这类 UI 事件，前提是真实 tool call/tool result 已经存在

绝不能丢弃：

- 用户消息
- assistant 最终回答
- 工具错误
- 命令输出摘要
- 验证结果
- 文件路径和行号
- 用户明确偏好、纠正或约束

如果丢弃数量明显，应在 transcript 中留下标记：

```text
[omitted UI-only progress messages: 7]
```

### 6. 折叠重复日志

重复日志应在送入 summarizer 之前折叠。

规则：

- 连续重复行只保留一行，并记录重复次数。
- 重复 warning block 只保留一次，并记录出现次数。
- 重复测试失败按测试名或错误签名分组。
- Stack trace 保留开头、与项目相关的 frame、最终原因。

示例：

```text
Warning: repeated event
Warning: repeated event
Warning: repeated event
```

压缩为：

```text
Warning: repeated event
[previous line repeated 3 times]
```

### 7. 按工具类型语义化压缩工具结果

工具结果在进入 summarizer 前，应先根据工具类型进行语义化压缩。

#### 文件读取

保留：

- 文件路径
- 行号范围
- 看到的关键 symbol、class、function
- 后续被引用、修改或对任务重要的代码片段

丢弃或截断：

- 与任务无关的长文件内容
- 没有新增信息的重复文件读取

#### Grep/Search

保留：

- 查询 pattern
- 搜索路径
- 命中数量
- 最相关文件
- 代表性匹配行

丢弃：

- 大量完整命中列表
- generated files、build output 中的重复匹配

#### Shell 命令

保留：

- command
- exit status
- 成功或失败
- 关键 stdout
- stderr
- 测试/构建摘要
- 重要错误行

丢弃：

- 进度条
- 依赖安装噪声
- 重复 warning
- stack trace 中间的大段重复内容

#### 文件编辑/写入

保留：

- 文件路径
- 操作类型
- 是否成功
- 简洁变更摘要
- 必要的 before/after 关键片段

丢弃：

- 巨大的完整 `new_string` 或整文件内容，除非它本身很短且必须保留

#### 文件列表

保留：

- 查询 glob/path
- 总数量，如果可知
- 与任务相关的路径

丢弃：

- 几百上千条无关路径

### 8. 长文本采用 Head + Signals + Tail 截断

长输出不能简单只取前 N 个字符。

应该保留三部分：

1. head：开头部分
2. signals：关键信号行
3. tail：结尾部分

关键信号行包括：

- `error`、`failed`、`failure`、`exception`
- `traceback`、`stack`
- 带行号/列号的文件路径
- 测试摘要
- 构建摘要
- TypeScript 或 lint 诊断
- exit code

每次截断都必须显式标记：

```text
[truncated: original 84230 chars, kept 11842 chars]
```

### 9. Token Budget 策略

预算处理顺序：

1. 移除 UI 噪声。
2. 折叠重复行/重复块。
3. 按工具类型压缩工具结果。
4. 对长输出做 head/signals/tail 截断。
5. 丢弃低价值的旧 assistant 解释。
6. 保留近期用户消息和当前工作状态。
7. 如果仍然过长，将 transcript 分块，先生成 partial summary，再汇总成最终 checkpoint。

不能简单地“从最旧消息开始删除”。旧消息中的关键约束、用户偏好、技术决策必须保留下来。

### 10. 生成 Checkpoint

Checkpoint summarizer 应该禁用工具。它不应该在生成 summary 的过程中修改主会话历史。

Prompt 应要求输出结构化交接内容：

```markdown
# Compact Checkpoint

## User Intent

## Current State

## Constraints and Preferences

## Files Inspected

## Files Modified

## Tool Results and Evidence

## Key Decisions

## Errors and Fixes

## Validation

## Pending Work

## Immediate Next Step
```

Summary 必须事实准确、具体、面向继续执行。

应该包含：

- 精确文件路径
- 命令名称
- 验证结果
- 已知失败
- 用户纠正
- 架构约束
- 当前未完成工作

应该排除：

- 无关闲聊
- 重复日志
- 隐藏 chain-of-thought
- 推测性的意图
- 已经过时、不再相关的旧计划

### 11. 清洗 Summary

生成后应进行清洗：

- 移除 `<analysis>` 或 scratchpad 内容。
- 移除空标题。
- 移除泛泛而谈的 filler。
- 确保必需章节存在。
- 确保 pending work 和 next step 明确。
- 如果任务已经完成，要明确写明。

### 12. 原子替换活跃上下文

Compact 必须是原子操作：

```text
构建规范化 transcript
→ 生成 checkpoint
→ 校验 checkpoint
→ 构造新 messages
→ 替换活跃历史
```

任何一步失败，都必须保持原始历史不变。

替换后的活跃上下文通常应是：

```ts
[
  {
    type: 'user',
    content: [
      {
        type: 'text',
        text: `${COMPACT_SUMMARY_PREFIX}\n\n${summary}`,
      },
    ],
  },
]
```

Compact 后不要继续在活跃上下文中保留原始历史 tool calls。否则容易带来 provider 格式不匹配、orphan tool message、重复执行旧工作、压缩效果差等问题。

### 13. 元数据与审计记录

虽然活跃上下文被替换，但 compact 应在模型上下文之外记录元数据：

```ts
type CompactRecord = {
  id: string;
  createdAt: string;
  beforeMessageCount: number;
  afterMessageCount: number;
  beforeTokenEstimate: number;
  afterTokenEstimate: number;
  omittedUiMessages: number;
  truncatedOutputs: number;
};
```

这些 metadata 用于 debug、session restore、日志导出，以及未来 fork/auto-compact 能力。它们不一定要注入模型上下文。

## 核心原则

1. Compact 是历史重写，不是普通聊天 turn。
2. Summarizer 看到的是语义化 transcript，不是 provider 原始消息。
3. 工具历史应作为证据被总结，而不是在 compact 后继续 replay。
4. 不从工具调用中推断隐藏意图。
5. 截断必须显式，并且保留关键信号。
6. 最终活跃上下文应小、provider-safe、面向继续执行。
7. Compact 失败时，原始历史必须保持不变。
