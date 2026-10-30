/**
 * By The Way 线程的上限。
 *
 * 一条线程 = 一个隔离子代理 + 一份消息数组，所以必须有上限；到上限时如实拒绝新的
 * tab，不悄悄淘汰旧的（被淘汰的 tab 在客户端还在，点进去只会用 host 已不认识的 id
 * 重建空线程，之前的问答就没了）。
 *
 * 为什么放在 `mica-common`：判定在 host（`apps/cli/src/runtime/btwThread.ts`），
 * 而「+ 到底还能不能点」在渲染层就要答出来——用户在点之前就该看到它不可用，而不是
 * 点了才收到一句拒绝。上限只有一份，两处才不会各自漂移。
 */
export const BTW_MAX_THREADS = 6;
