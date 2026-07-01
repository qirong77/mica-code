# 后台命令执行：让长任务不阻塞 Agent

> 本文是 [mica-code](https://github.com/qirong77/mica-code) 系列文章之一。mica-code 是一个从零搭建的 CLI code agent，基于 Bun + TypeScript + React（Ink）+ Anthropic SDK，目标是搞清楚 Claude Code 这类工具底层到底怎么工作。

ToolRunShell 加上那个 abort kill 的时候，我以为问题解决了。

第二天跑了个测试——agent 执行 `npm run dev`，Vite 服务器启动，输出 "ready in 352ms"，然后……什么都没发生。30 秒超时到了，SIGTERM → SIGKILL，进程死了，agent 继续。但你不会想等 30 秒的——那感觉就像在一个卡死的网页上盯着转圈圈，然后突然好了。这不是解决方案，这是止损。

你真正需要的是：agent 说"这个命令我帮你跑起来了，输出在这儿，需要的话用 read_file 看——我们继续聊正事。"启动 Vite 花了 0.3 秒，agent 的迭代循环不应该为它停哪怕一秒。

---

## 第一章：三个方案，两个不对

### 方案 A：等超时

这就是上一篇文章做的——abort kill。30 秒默认超时，到了就杀。对不对？技术上没错。好用吗？不好用。用户启动一个 dev server，等了 30 秒，进程被杀，server 没了，白搞。这就像你按了电梯按钮然后有人告诉你"30 秒内电梯没到的话我就把按钮抠掉"。

### 方案 B：自动检测并终止

判断命令输出是否"看起来完成了"。"ready in 352ms" 之后不再有输出，agent 判定命令稳定，自动终止。听起来很聪明。

但这个思路有一个致命的逻辑漏洞。Vite 的 Watch 模式启动后就等着——你改一个文件，它重新编译。它"看起来完成了"但根本不应该被终止。你怎么区分 "npm run build 结束了" 和 "npm run dev 进入 watch 模式了"？靠正则匹配输出？vite 一句 "ready"，webpack 一句 "compiled successfully"，turbo 一句 "cache hit"。随便换一个工具就失效。不是不能做，是做出来会脆弱得像纸牌屋。

### 方案 C：让模型主动声明

claude-code 的做法。给 shell tool 加一个 `run_in_background` 参数，在 system prompt 里告诉模型"长时间运行的命令传这个参数"。模型收到带 `run_in_background: true` 的命令后，spawn 一个 detached 子进程，输出写到文件，立即返回。agent 的 iteration loop 不阻塞。命令完成后通过通知机制告知模型结果。

为什么这个方案比 A 和 B 好？

1. 模型自己知道什么命令会长时间运行——不需要你用正则去猜
2. 不需要 30 秒的超时等待——命令只要 spawn 出去，tool 马上返回
3. 子进程持续运行——watch 模式、dev server 都不会被杀

---

## 第二章：`run_in_background` 的完整数据流

在拆实现之前，先看这个参数触发后会发生什么。假设模型执行：

```
run_shell(command: "npm run dev", run_in_background: true)
```

### 2.1 Tool 立即返回

不是 "等命令执行完再返回结果"。subprocess spawn 出去的同时，tool 构造一个特殊的返回值：

```ts
return {
  stdout: '',
  backgroundTaskId: 'local_bash_abc123',
  backgroundInfo: 'Command running in background. Output: /tmp/mica/tasks/abc123/output.txt',
};
```

这个返回值被拼成 tool_result 喂给模型。模型看到的是："命令在后台运行，输出文件在 `/tmp/.../output.txt`"——不是空白，而是继续工作所需的信息。

### 2.2 子进程写入文件，不经过 Node.js 事件循环

关键一步。如果子进程的 stdout 通过 pipe 连到 Node.js 的 stream，那主线程的 `data` 事件就要不断被触发，后台进程产生大量输出时仍然可能成为性能负担。

claude-code 的做法是：**stdout 和 stderr 都通过子进程的文件描述符直接写磁盘**。

```ts
const outputHandle = await open(taskOutput.path, O_WRONLY | O_CREAT | O_APPEND);

const child = spawn(binShell, shellArgs, {
  stdio: ['pipe', outputHandle.fd, outputHandle.fd],
  detached: true,
});
```

`outputHandle.fd` 是一个已打开的文件的文件描述符。spawn 时把它作为子进程的 fd 1（stdout）和 fd 2（stderr）——两个 fd 指向同一个文件，合并输出。数据不经过 Node.js 的 Readable stream，不触发主线程事件。

`detached: true` 确保子进程独立于父进程的生命周期——即便父进程的主线程被某些操作阻塞，OS 也会让子进程继续运行。

### 2.3 background() —— 切断所有 foreground 监听

```ts
background(taskId: string): boolean {
    this.#status = 'backgrounded';
    this.#cleanupListeners();    // 移除 abort handler、timeout
    this.#startSizeWatchdog();   // 防止日志无限增长撑爆磁盘
    return true;
}
```

`#cleanupListeners()` 做了三件事：

- **移除 abort handler**：foreground 的 abort signal 不再影响这个子进程。用户中断当前对话不会杀了 dev server
- **清除 timeout**：原来 30 秒后 SIGTERM 的倒计时，不适用于后台进程
- **启动 sizeWatchdog**：每隔 5 秒检查输出文件大小，超过上限（64MB）就 kill。这是纯防御——防止 `npm run dev` 的日志把磁盘写满

### 2.4 Agent 迭代继续

IterationRunner 的循环收到 tool result，判断没有更多 tool_use 调用但有文本内容 → 本轮迭代正常结束 → agent 可以处理下一条用户消息。dev server 在 OS 层面独立运行，完全不影响。

---

## 第三章：mica-code 的实现

claude-code 的后台任务有一整套框架——LocalShellTask、task notification XML 注入、后台任务完成通知。对 mica-code 来说，第一版只需要做到最小可用：spawn detached，输出到文件，tool 立即返回。

### 3.1 给 ToolRunShell 加 `run_in_background` 参数

```ts
{
  command: { type: 'string' },
  timeout: { type: 'number' },
  run_in_background: { type: 'boolean', description: '设为 true 在后台运行，不等待结果' },
}
```

### 3.2 execute 中分支处理

```ts
async execute(input, callbacks) {
  if (input.run_in_background) {
    return this.executeBackground(input);
  }
  return this.executeForeground(input, callbacks);
}
```

`executeBackground` 的核心逻辑：

```ts
private async executeBackground(input): Promise<string> {
  const taskId = randomBytes(8).toString('hex');
  const outputDir = path.join(tmpdir(), 'mica-tasks');
  const outputPath = path.join(outputDir, `${taskId}.out`);
  await fs.mkdir(outputDir, { recursive: true });

  const fd = await open(outputPath, O_WRONLY | O_CREAT | O_APPEND);
  const child = spawn(input.command, {
    shell: true,
    detached: true,
    stdio: ['ignore', fd, fd],
  });
  await fd.close();

  child.unref();  // 允许父进程退出而不等待子进程

  return `命令已在后台启动 (id: ${taskId})\n输出文件: ${outputPath}\n如需查看结果，用 read_file 读取输出文件。`;
}
```

几个要点：

- `detached: true` + `child.unref()`：子进程不阻止父进程退出
- `stdio: ['ignore', fd, fd]`：stdin 忽略，stdout/stderr 合并写文件
- 关闭父进程持有的 fd 引用：`await fd.close()`——子进程已经 dup 了自己的，父进程的可以关
- 返回信息引导模型：不需要 poll，用 read_file 读文件

### 3.3 在 system prompt 中引导模型使用

在 `system.md` 的 run_shell 工具描述后插入：

```
- run_shell 支持 run_in_background 参数。对于长时间运行的命令（dev server、watch 模式、长时间构建），设置 run_in_background: true。命令输出写入临时文件，后续可用 read_file 查看。
```

这行 prompt 是软约束——不强制，但给模型一个明确的行为指引。claude-code 靠这行 prompt 让模型在大部分场景主动传 run_in_background。

---

## 第四章：为什么不做得更"全面"

你可能会问：为什么不把后台任务框架做完整？task notification、完成通知、输出滚动查看？

因为 mica-code 的目标不是重新实现 claude-code，而是搞清楚关键路径怎么走。后台任务的核心机制有三个零件：

1. **模型主动声明**——system prompt 引导
2. **spawn detached + 文件 fd**——进程独立、输出不经过 JS
3. **立即返回**——不阻塞 iteration loop

这三个零件一做，`npm run dev` 就不再卡 agent 了。至于 task notification、进度条、Ctrl+B 快捷键——那些是体验优化，不是核心机制。知道怎么做了，以后有需要再加就行。

---

## 附：与前面 abort kill 的互补关系

两件事不冲突。

abort kill 解决的是："用户按了中断，但 foreground 命令还在跑。"它保证交互的即时性。

run_in_background 解决的是："命令本来就不该等，但模型忘了说。"它保证交互的流畅性。

一个有 run_in_background 意识的 agent + 有 abort kill 的 runtime = 几乎不会卡住的 shell 执行体验。两套机制，一软一硬，覆盖不同的 failure mode。
