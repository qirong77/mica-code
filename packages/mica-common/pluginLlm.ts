/**
 * 「复用当前会话模型」的判定：插件运行期决定发哪个地址，配置页决定开关显示成什么，
 * 两边必须同一个答案，所以放在跨端纯逻辑里。
 *
 * 缺省就是复用（插件声明了 `llm` 就是要问模型，会话里那一个已经付过钱、也认上下文）；
 * 只有明确拨到「关」才用插件自己的接口，面板上那四项也是这时候才需要填。
 */
export function resolveUseMainProvider(values: Record<string, string | undefined>): boolean {
  const explicit = (values.useMainProvider ?? '').trim();
  return explicit !== 'false';
}
