/**
 * Read-only snapshots emitted through `agent:observe` by AgentRuntime.
 * `owner` is the runtime identity; consumers must not mutate it. No text or
 * thinking deltas are included. Request events fire before each model request,
 * including the first and failed requests, and exclude transport retry attempts.
 */
export type AgentObservationEvent = Readonly<{
  owner: object;
  runId: number;
  timestamp: string;
}> &
  (
    | Readonly<{
        type: 'run:start';
        input: unknown;
        config: Readonly<{ providerId: string; protocol: string; model: string; effort: string; role: string }>;
        /**
         * 这条运行由委派产生时带上，说明它是被谁派生的。
         *
         * `type` 是子代理类型名（`Explore` / `Implementer` …）；`parentSessionId` 是派生它的
         * 会话。两者一起才能把委派树拼回来，并回答「哪种类型的子代理回报最差」。
         */
        delegation?: Readonly<{ type: string; parentSessionId?: string }>;
        /**
         * 这条运行不是会话里的一轮：压缩摘要、旁问线程、插件自己问模型这类宿主内部
         * 工作也在花钱、也会失败，却不属于任何一次用户请求。
         *
         * `kind` 是稳定的来源短名（`compaction` / `btw` / `thread` / `plugin-llm` /
         * `subagent`），`pluginId` + `purpose` 只在插件发起时出现。观察方按这三项
         * 归并：「自动压缩每次摘要要 40 秒」与「某一轮慢」是两件不同的事，混在
         * 一起就只能看到总时长。
         */
        helper?: Readonly<{ kind: string; pluginId?: string; purpose?: string }>;
      }>
    | Readonly<{
        type: 'request:start';
        messageCount: number;
        /** Snapshot of the exact tool definitions sent by the provider; absent when tools are disabled. */
        tools?: unknown;
      }>
    | Readonly<{
        type: 'request:end';
        /** 建流 + 流消费（含传输层重试）的总耗时。 */
        durationMs: number;
        /** 首个正文/思考增量到达的时刻（排队 + 首字），无输出时缺省。 */
        firstTokenMs?: number;
        attempts: number;
        outcome: 'completed' | 'error' | 'aborted';
        toolCalls?: number;
        error?: string;
      }>
    | Readonly<{ type: 'prompt:resolved'; prompt: string }>
    | Readonly<{ type: 'history:rewritten'; beforeCount: number; afterCount: number }>
    | Readonly<{ type: 'tool:call'; name: string; args: string; id?: string }>
    | Readonly<{ type: 'tool:result'; name: string; result: string; id?: string }>
    | Readonly<{
        type: 'usage';
        usage: Readonly<{
          inputTokens: number;
          outputTokens: number;
          cachedInputTokens?: number;
          totalTokens?: number;
          model?: string;
        }>;
      }>
    | Readonly<{ type: 'retry'; attempt: number; delayMs: number; error: string }>
    | Readonly<{
        /**
         * 上下文被压缩。`history:rewritten` 说明改写发生过，这里说明**是谁、改了多少**——
         * 两者不能合并：改写也可能来自插件重写历史，而压缩直接决定模型接下来看到什么。
         */
        type: 'compaction';
        /** 动手的那一类机制：本地清理 / 模型摘要 / 宿主空闲维护。 */
        strategy: 'local' | 'llm' | 'idle';
        /** 触发来源的稳定短名（`session-compact`、`compact`、`idle`）。 */
        reason: string;
        beforeMessages: number;
        afterMessages: number;
        beforeChars?: number;
        afterChars?: number;
        /** 是否真的改了历史。`false` 表示这次检查后决定不压。 */
        applied: boolean;
      }>
    | Readonly<{
        type: 'run:finish';
        /** `paused`：在迭代边界被宿主主动停下，历史完整，可以原地续跑。 */
        outcome: 'completed' | 'aborted' | 'error' | 'paused';
        elapsedMs: number;
        error?: string;
      }>
  );
