/**
 * 会话快照里模型历史的形态标记。
 *
 * 只有一种形态：pi-ai 的 `Message[]`。协议（Chat / Responses / Anthropic /
 * Google）只决定下一次请求怎么编码，不再决定历史怎么存，所以快照里既不留
 * wire 结构，也不按协议分叉。运行时的读、写两端都按这个标记拒绝其它形态，
 * 不做回退。
 */
export const PI_MESSAGE_FORMAT = 'pi-ai-v1' as const;

export type PiMessageFormat = typeof PI_MESSAGE_FORMAT;

/** 读到非当前形态快照时的统一说法。 */
export const PI_MESSAGE_FORMAT_ERROR = '会话的模型历史不是当前格式，无法读取。';
