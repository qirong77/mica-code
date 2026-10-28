/**
 * 「跟随主配置」的判定：插件运行期决定发哪个地址，配置页决定开关显示成什么，
 * 两边必须同一个答案，所以放在跨端纯逻辑里。
 *
 * 三态：开关被用户明确拨过就以它为准；没表态时看有没有填自己的地址——**留空就是
 * 跟随主配置**。只认显式值的话，已经填过地址的老配置会因为「开关默认开」而突然
 * 改走主配置，而页面上又看不出原因。
 */
export function resolveUseMainProvider(
  followMain: boolean | undefined,
  values: Record<string, string | undefined>,
): boolean {
  if (followMain !== true) return false;
  const explicit = (values.useMainProvider ?? '').trim();
  if (explicit === 'true') return true;
  if (explicit === 'false') return false;
  return !(values.baseUrl ?? '').trim();
}
