/** 运行时环境变量来源，默认使用 process.env；测试时可注入自定义对象。 */
export type RuntimeEnvSource = Record<string, string | undefined>;

/** 运行时调参配置结构，由 readRuntimeEnvConfig 的返回值推导。 */
export type RuntimeEnvConfig = ReturnType<typeof readRuntimeEnvConfig>;

/** 进程启动时读取一次的运行时调参配置快照。 */
export const runtimeEnv = readRuntimeEnvConfig();

/**
 * 从环境变量读取运行时调参配置。
 *
 * 这些配置只影响当前进程的 UI 节流、日志展示和文本截断策略，不写入 config.json。
 */
export function readRuntimeEnvConfig(env: RuntimeEnvSource = process.env) {
  return {
    ui: {
      // 控制状态更新合并的最小间隔，避免 UI 高频重绘。
      scheduleStateThrottleMs: intEnv(env, 'MICA_UI_SCHEDULE_STATE_THROTTLE_MS', 16, { min: 1, max: 1000 }),
      // 控制 thinking 文本刷新间隔，平衡流式反馈速度和渲染成本。
      thinkingUpdateIntervalMs: intEnv(env, 'MICA_UI_THINKING_UPDATE_INTERVAL_MS', 30, { min: 16, max: 2000 }),
      // 控制耗时显示的刷新间隔。
      elapsedRefreshIntervalMs: intEnv(env, 'MICA_UI_ELAPSED_REFRESH_INTERVAL_MS', 100, { min: 50, max: 5000 }),
      // 控制加载动画帧切换间隔。
      spinnerFrameIntervalMs: intEnv(env, 'MICA_UI_SPINNER_FRAME_INTERVAL_MS', 80, { min: 20, max: 2000 }),
      // shell 命令超过该耗时后才展示更详细的执行日志。
      runShellVerboseLogThresholdMs: intEnv(env, 'MICA_RUN_SHELL_VERBOSE_LOG_THRESHOLD_MS', 2000, {
        min: 0,
        max: 60_000,
      }),
      // shell 日志在 UI 中最多展示的行数。
      runShellLogMaxLines: intEnv(env, 'MICA_RUN_SHELL_LOG_MAX_LINES', 10, { min: 1, max: 200 }),
      // 助手消息整体展示的最大字符数，防止长输出拖慢界面。
      assistantDisplayMaxChars: intEnv(env, 'MICA_UI_ASSISTANT_DISPLAY_MAX_CHARS', 80_000, {
        min: 1_000,
        max: 1_000_000,
      }),
      // 普通消息文本的最大字符数。
      messageTextMaxChars: intEnv(env, 'MICA_UI_MESSAGE_TEXT_MAX_CHARS', 80_000, {
        min: 1_000,
        max: 1_000_000,
      }),
      // response 文本的最大字符数。
      responseTextMaxChars: intEnv(env, 'MICA_UI_RESPONSE_TEXT_MAX_CHARS', 80_000, {
        min: 1_000,
        max: 1_000_000,
      }),
      // thinking 文本的最大字符数。
      thinkingTextMaxChars: intEnv(env, 'MICA_UI_THINKING_TEXT_MAX_CHARS', 40_000, {
        min: 1_000,
        max: 500_000,
      }),
    },
  } as const;
}

/** 读取整数环境变量；缺失、空值或非法数字时使用 fallback，并将结果限制在 min/max 范围内。 */
function intEnv(env: RuntimeEnvSource, name: string, fallback: number, options: { min: number; max: number }): number {
  const raw = env[name];
  if (!raw?.trim()) return fallback;

  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return fallback;

  return Math.max(options.min, Math.min(options.max, Math.floor(parsed)));
}
