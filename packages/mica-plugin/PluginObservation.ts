/**
 * 插件自己的运行事件：不是某一次 agent 运行的一部分，却同样会坏、同样值得复盘。
 *
 * 与 `agent:observe` 分开的理由是归属：那些事件挂在一条 run 上（`owner` + `runId`），
 * 而常驻任务失败、插件动作失败发生在任何一轮之外——硬塞进某条 run，只会让那条 run
 * 的耗时与失败原因都变成假的。宿主用 `hooks.notify('plugin:observe', event)` 发出，
 * 插件通过 `ctx.hooks.on('plugin:observe', …)` 订阅；与 `agent:observe` 一样是只读通知，
 * 抛错或永不完成的观察方都不影响插件本身。
 */
export type PluginObservationEvent = Readonly<{
  pluginId: string;
  timestamp: string;
}> &
  (
    | Readonly<{
        /**
         * `ctx.background.register()` 注册的常驻任务抛错了。
         *
         * 常驻任务是最容易「静默坏掉」的一类：它不在任何一轮里，失败只进日志与健康状态，
         * 用户看到的只是「这个功能没反应」。带上 tick 才能把「偶发一次」和「每轮都失败」
         * 分开。
         */
        type: 'background:failed';
        taskId: string;
        /** 第几次尝试（从 1 开始，失败也递增）。 */
        tick: number;
        /** 这个任务累计失败次数。 */
        failures: number;
        error: string;
      }>
    | Readonly<{
        /**
         * 插件的钩子处理函数抛错了。默认 `failPolicy: 'continue'` 会吞掉异常（这是对的：
         * 一个插件的钩子不该打断整个 turn），但「每轮都在炸」与「功能没反应」在用户眼里
         * 是同一件事，只有事件流分得开。
         */
        type: 'hook:failed';
        hook: string;
        error: string;
      }>
  );
