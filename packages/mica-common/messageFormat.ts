/**
 * 会话快照里模型历史的形态标记。
 *
 * 只有一种形态：pi-ai 的 `Message[]`。协议（Chat / Responses / Anthropic /
 * Google）只决定下一次请求怎么编码，不再决定历史怎么存，所以快照里既不留
 * wire 结构，也不按协议分叉。旧的原生历史由 `evolution` 的 `pi-messages-v1`
 * 一次性迁过来；运行时的读、写两端都按这个标记拒绝未迁移的快照，不做回退。
 */
export const PI_MESSAGE_FORMAT = 'pi-ai-v1' as const;

export type PiMessageFormat = typeof PI_MESSAGE_FORMAT;

/** 读写到未迁移快照时的统一说法：用户要跑一次 evolution，而不是换个会话。 */
export const PI_MESSAGE_FORMAT_ERROR = '旧的模型历史格式不再支持，请先运行 evolution 迁移会话。';
