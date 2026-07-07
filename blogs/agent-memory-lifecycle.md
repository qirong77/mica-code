# Agent 内存治理：从一个关不掉的 mica 进程说起

> 本文是 [mica-code](https://github.com/qirong77/mica-code) 系列文章之一。mica-code 是一个从零搭建的 CLI code agent，基于 Bun + TypeScript + React（Ink）+ Anthropic SDK，目标是搞清楚 Claude Code 这类工具底层到底怎么工作。

这次问题不是从测试失败开始的，而是从活动监视器开始的。

我看到系统里有好几个 `mica` 进程，其中两个内存占用很夸张：一个 5GB 多，一个 2GB 多。再看进程列表，当前终端前台只跑着一个 `mica`，但后台还挂着一串旧进程。它们的 `PPID` 是 `1`，TTY 是 `??`。

这基本说明了一件事：终端窗口关掉了，但 `mica` 没退出。进程变成孤儿进程，被 `launchd` 接管，继续在后台活着。

手动 `kill` 可以释放内存，但这只是清理现场，不是修问题。真正的问题是：**一个 Code Agent 到底应该在哪些边界释放内存？**

这篇记录 mica-code 对内存生命周期做的一次改造。

---

## 一、第一类问题：进程生命周期泄漏

最直接的问题在入口文件。

mica-code 原来只监听了：

```ts
process.on('SIGINT', requestSignalExit);
process.on('SIGTERM', requestSignalExit);
```

但关闭终端窗口时，终端通常发送的是 `SIGHUP`。

如果进程没有处理 `SIGHUP`，它不一定会按 CLI 程序的预期退出。结果就是：用户以为自己关掉了 mica，实际上它只是脱离了终端，继续挂在后台。

所以第一步是补上 `SIGHUP`：

```ts
process.on('SIGINT', requestSignalExit);
process.on('SIGTERM', requestSignalExit);
process.on('SIGHUP', requestSignalExit);
```

退出码也按 Unix 习惯处理：

```txt
SIGHUP  -> 129
SIGINT  -> 130
SIGTERM -> 143
```

但只补 signal 还不够。

因为 `app.requestExit()` 是优雅退出：卸载插件、关闭 MCP 连接、注销工具、保存 session、卸载 UI。这些步骤里任何一个卡住，进程还是可能不退出。

参考 `temp/pi` 里的处理方式，signal shutdown 不应该只依赖“大家都能优雅完成”。它需要一个兜底：

```ts
const SIGNAL_EXIT_FORCE_TIMEOUT_MS = 10_000;

signalExitTimer = setTimeout(() => process.exit(exitCode), SIGNAL_EXIT_FORCE_TIMEOUT_MS);
signalExitTimer.unref?.();

void app
  .requestExit(exitCode)
  .catch((error) => {
    reportRuntimeError(error, '退出失败');
    process.exit(exitCode);
  })
  .finally(() => {
    if (signalExitTimer) clearTimeout(signalExitTimer);
    signalExitTimer = null;
  });
```

这里的原则很简单：

> 优雅退出是第一选择，但进程生命周期不能无限等待优雅退出。

对 CLI agent 来说尤其如此。用户关闭终端窗口后，不会再回来帮你按第二次 Ctrl+C。

---

## 二、第二类问题：session 被移除了，但引用还在

清掉孤儿进程后，还有另一个更像“真泄漏”的问题：多 agent session。

mica-code 支持创建多个 agent、fork 当前 agent、后台运行 agent，再用 `/agents clear` 清理 idle agent。

原来的清理逻辑大概是：

```ts
session.disposeStatusListener();
session.agent.abort();
this.sessions.splice(index, 1);
```

看起来 session 已经从列表里删掉了。

但 JavaScript 里对象能不能被 GC，不取决于它在不在某个“主列表”里，而取决于是否还有强引用指向它。

而 runtime 和 UI bridge 里还有很多以 `AgentRuntime` 为 key 的 Map/Set：

```ts
private readonly responseBuffers = new Map<AgentRuntime, string>();
private readonly committedResponseBuffers = new Map<AgentRuntime, string>();
private readonly queues = new Map<AgentRuntime, RuntimeInput[]>();
private readonly sessionControllers = new Map<AgentRuntime, SessionController>();
private readonly exclusiveTasks = new Map<AgentRuntime, Promise<unknown>>();
```

UI bridge 里也有类似结构：

```ts
private readonly toolLogs = new Map<AgentRuntime, ToolLogController>();
private readonly disposers = new Map<AgentRuntime, () => void>();
private readonly messageTimers = new Map<string, ReturnType<typeof setTimeout>>();
private readonly preserveTurnUiOnConnecting = new Set<AgentRuntime>();
```

如果 `/agents clear` 只从 `TerminalAgentSessionManager` 里删掉 session，而这些 Map 没同步清理，那么 idle agent 仍然被 runtime/UI 层强引用着。它的 provider history、conversation messages、tool results、rewind checkpoints 都可能跟着留在内存里。

这类问题不能靠 GC 自动解决。GC 不知道“这个 agent 已经没用了”，因为从引用图上看，它确实还被用着。

所以需要给 runtime 和 UI bridge 增加明确的 per-agent dispose 边界。

runtime 侧：

```ts
disposeAgent(agent: AgentRuntime): void {
  this.responseBuffers.delete(agent);
  this.committedResponseBuffers.delete(agent);
  this.queues.delete(agent);
  this.sessionControllers.delete(agent);
  this.clearingAgents.delete(agent);
  this.exclusiveTasks.delete(agent);
  this.rewindCheckpoints.clear(agent);
  this.runningAgents.delete(agent);
}
```

UI bridge 侧：

```ts
disposeAgent(agent: AgentRuntime): void {
  this.disposers.get(agent)?.();
  this.disposers.delete(agent);
  this.toolLogs.delete(agent);
  this.preserveTurnUiOnConnecting.delete(agent);

  for (const [id, owner] of this.messageTimerOwners) {
    if (owner !== agent) continue;
    const timer = this.messageTimers.get(id);
    if (timer) clearTimeout(timer);
    this.messageTimers.delete(id);
    this.messageTimerOwners.delete(id);
  }
}
```

然后 `/agents clear` 不再只是删 session：

```ts
const result = context.agentSessions.clearIdleSessions({
  onClear: (session) => {
    context.runtime.disposeAgent(session.agent);
    context.uiBridge.disposeAgent(session.agent);
  },
});
```

这里的原则是：

> 谁持有资源，谁提供释放边界；谁发起删除，谁串起这些释放边界。

只把对象从一个数组里删掉，不等于释放了对象。

---

## 三、第三类问题：历史不是泄漏，但会长成泄漏的样子

前两类问题都比较明确：进程不该活着却活着；agent 不该被引用却被引用。

但 Code Agent 还有一类更麻烦的内存增长：provider history。

模型客户端为了连续对话，会保存历史 messages。每轮用户输入、assistant 回复、tool call、tool result 都会进入历史。这个设计本身没有错，因为下一轮模型需要这些上下文。

问题在于工具结果。

一次 `read_file` 可能返回几十 KB；一次 `run_shell` 可能返回上百 KB；一次 `web_fetch` 可能拿到很长的页面正文。工具层即使已经做了输出限制，历史里仍然会累计大量字符串。

这不是传统意义上的 leak，因为它们确实还在历史里。但从用户视角看，效果差不多：进程越聊越大，长会话最终能吃掉几个 GB。

mica-code 之前有一个不一致的地方：Chat Completions 会压缩历史 tool result，但 Anthropic 和 Responses 没有同样的逻辑。

这次把三类 provider 统一了。

新增一个通用 helper：

```ts
export const MAX_HISTORICAL_TOOL_RESULT_CHARS = 12_000;

export function compactHistoricalToolResultText(
  text: string,
  maxChars = MAX_HISTORICAL_TOOL_RESULT_CHARS,
): string {
  if (text.length <= maxChars) return text;

  let omitted = text.length - maxChars;
  let marker = '';
  let headChars = 0;

  for (let index = 0; index < 10; index++) {
    marker = `\n\n[历史工具结果已压缩，省略 ${omitted} 字符。如需完整内容，请重新读取对应文件或重新运行相关工具。]`;
    headChars = Math.max(0, maxChars - marker.length);
    const nextOmitted = text.length - headChars;
    if (nextOmitted === omitted) break;
    omitted = nextOmitted;
  }

  return `${text.slice(0, headChars)}${marker}`;
}
```

然后分别适配三种消息格式。

Anthropic 的 tool result 在 user message content 里：

```ts
function compactHistoricalToolResults(messages: MessageParam[]): MessageParam[] {
  return messages.map((message) => {
    if (message.role !== 'user' || typeof message.content === 'string') return message;

    let changed = false;
    const content = message.content.map((part) => {
      if (part.type !== 'tool_result' || typeof part.content !== 'string') return part;
      const compacted = compactHistoricalToolResultText(part.content);
      if (compacted === part.content) return part;
      changed = true;
      return { ...part, content: compacted };
    });

    return changed ? { ...message, content } : message;
  });
}
```

Responses 的 tool result 是 `function_call_output`：

```ts
function compactHistoricalToolResults(messages: ResponseInputItem[]): ResponseInputItem[] {
  return messages.map((item) => {
    if (item.type !== 'function_call_output' || typeof item.output !== 'string') return item;
    const compacted = compactHistoricalToolResultText(item.output);
    return compacted === item.output ? item : { ...item, output: compacted };
  });
}
```

Chat Completions 的 tool result 是 `role: 'tool'`：

```ts
function compactHistoricalToolResults(
  messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[],
): OpenAI.Chat.Completions.ChatCompletionMessageParam[] {
  return messages.map((message) => {
    if (message.role !== 'tool') return message;
    if (typeof message.content !== 'string') return message;
    if (message.content.length <= MAX_HISTORICAL_TOOL_RESULT_CHARS) return message;

    return {
      ...message,
      content: compactHistoricalToolResultText(message.content),
    };
  });
}
```

还有一个细节很重要：压缩不能只发生在“下一轮请求前”。

如果本轮刚执行完一个很大的工具结果，然后把完整 messages 保存进 `this.messages`，那么这坨大字符串至少会在内存里躺到下一轮。长任务、中断、后台 agent 都可能让它停留更久。

所以压缩点应该尽量靠近状态提交边界：

```ts
loadSnapshot(...)
preserveAbortedTurn(...)
commitCompleteIteration(...)
```

换句话说：

> 大工具结果可以在当前推理链路里短暂存在，但不应该长期进入 provider history。

---

## 四、哪些东西没有一刀切掉

这次改造不是把所有历史都删掉。

Code Agent 的内存状态里，有些东西确实应该保留：

1. 最近对话：模型需要连续性。
2. 用户刚刚给的约束：不能靠摘要丢掉。
3. 工具调用结构：provider 需要 tool call 和 tool result 对齐。
4. rewind checkpoints：用户撤回或重试时需要恢复现场。

所以这次没有做“每轮结束就清空历史”这种粗暴方案。

rewind checkpoints 本身已经有上限，例如每个 agent 最多保存一定数量，单个 conversation snapshot 和 dirty file snapshot 也有预算。它不是无界泄漏，但它确实是长会话里的内存成本。

更合理的方向是分层治理：

```txt
进程生命周期：收到退出信号必须退出
agent 生命周期：idle agent 被清理时必须释放引用
历史生命周期：大工具结果不能长期原样保存
上下文生命周期：长会话需要 compact，而不是无限追加
```

这几层不能互相替代。

`SIGHUP` 修好了，不代表长会话不会涨。

`/compact` 做好了，不代表 idle agent 不会被 Map 引用。

工具输出限制做好了，也不代表 provider history 里不会累计历史大字符串。

Agent 的内存治理，真正难的地方就在这里：它不是一个开关，而是一组边界。

---

## 五、测试应该压住什么

这类改动如果只靠肉眼看，很容易漏。

这次补了几类测试。

第一类是 runtime per-agent 引用清理：

```ts
controller.appendResponseTextFor(agent, 'cached response');
controller.enqueueForAgent(agent, micaRuntime.createRuntimeInput('queued', 'ui'));

expect(controller.getResponseBufferFor(agent)).toBe('cached response');
expect(controller.countQueueForAgent(agent)).toBe(1);

controller.disposeAgent(agent);

expect(controller.getResponseBufferFor(agent)).toBe('');
expect(controller.countQueueForAgent(agent)).toBe(0);
```

第二类是 UI bridge listener 释放：

```ts
bridge.start();
bridge.disposeAgent(agent);

expect(agent.events.off).toHaveBeenCalledWith('status', expect.any(Function));
expect(agent.events.off).toHaveBeenCalledWith('text', expect.any(Function));
expect(agent.events.off).toHaveBeenCalledWith('thinking', expect.any(Function));
expect(agent.events.off).toHaveBeenCalledWith('toolCall', expect.any(Function));
expect(agent.events.off).toHaveBeenCalledWith('toolResult', expect.any(Function));
expect(agent.events.off).toHaveBeenCalledWith('usage', expect.any(Function));
```

第三类是 bridge stop 后不再响应 runtime event：

```ts
bridge.start();
bridge.stop();

runtime.events.publish({
  type: 'queue:changed',
  pendingInputs: [micaRuntime.createRuntimeInput('after stop', 'ui')],
  owner: agent,
});

expect(session.uiState.pendingInputs).toEqual([]);
```

第四类是三种 provider 的历史工具结果压缩：

```ts
expect(JSON.stringify(agent.getSnapshot().messages[1])).toContain('历史工具结果已压缩');
expect(JSON.stringify(agent.getSnapshot().messages[1]).length).toBeLessThan(
  MAX_HISTORICAL_TOOL_RESULT_CHARS + 500,
);
```

测试的目标不是证明“内存一定不会涨”。这几乎没法靠单元测试证明。

测试真正压住的是几个边界条件：

- 清理 agent 时，runtime 引用消失；
- 清理 agent 时，UI listener 消失；
- stop 后，bridge 不再响应事件；
- 恢复或保存 provider history 时，大工具结果不会原样长期保存。

这些边界稳定了，内存增长才有机会变得可解释。

---

## 六、最后的经验

这次问题一开始看起来只是“活动监视器里有几个 mica 很大”。但拆开之后，其实是三个不同层次的问题：

```txt
进程还活着：SIGHUP 没处理
对象还活着：Map/Set 强引用没释放
历史还变大：tool result 原样进入 provider history
```

它们的修法完全不同。

第一类靠 signal handling 和 force exit。

第二类靠显式 dispose 边界。

第三类靠历史预算和状态提交时压缩。

这也是我现在更倾向的一条规则：

> Code Agent 里的“内存泄漏”不一定是某个对象写错了，它更常见地来自生命周期边界没定义清楚。

工具调用、模型历史、UI 状态、checkpoint、多 agent session、后台任务、插件连接，这些东西都不是普通 CLI 小程序会同时拥有的状态。只要其中一层没有释放边界，长会话就会把问题放大。

所以内存治理不应该等到用户看到 5GB 进程时才做。它应该像工具输出限制、上下文压缩、后台任务管理一样，是 Code Agent 架构的一部分。

最终这次改造后，mica-code 至少收住了几个关键入口：

- 关闭终端时，`SIGHUP` 会触发优雅退出；
- 优雅退出卡住时，10 秒后强制退出；
- 清理 idle agent 时，runtime 和 UI bridge 会释放 per-agent 引用；
- provider history 里的历史工具结果会被压缩到固定预算内；
- 三类 provider 的行为保持一致。

这还不是内存治理的终点。

普通 user/assistant 文本、图片内容、长会话摘要、checkpoint 预算、自动 compact 策略，这些后面都还能继续做。但至少现在，几个最容易把 mica 拖成 GB 级后台进程的路径，已经有了明确边界。
