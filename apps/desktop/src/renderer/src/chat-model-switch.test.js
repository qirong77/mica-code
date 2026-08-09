import { describe, expect, it } from 'bun:test'
import { resolveModelSwitchProtocol } from './ChatView'

// protocolMap 与 ChatView 中 listModels 的构建一致：
// { [modelId]: { protocol, efforts } }
function protocolMap(entries) {
  const map = {}
  for (const [id, protocol] of Object.entries(entries || {})) {
    map[id] = { protocol, efforts: [] }
  }
  return map
}

describe('model switch protocol guard', () => {
  describe('new session (no history)', () => {
    it('allows switching to any model even across protocols', () => {
      expect(
        resolveModelSwitchProtocol({
          modelId: 'other/responses-model',
          hasHistory: false,
          protocolMap: protocolMap({ 'other/responses-model': 'openai_responses' }),
          currentProtocol: 'openai_chat_completions'
        })
      ).toEqual({ allowed: true })
    })

    it('allows switching when the protocol map is not loaded yet', () => {
      expect(
        resolveModelSwitchProtocol({
          modelId: 'krill/chat-model',
          hasHistory: false,
          protocolMap: null,
          currentProtocol: 'openai_responses'
        })
      ).toEqual({ allowed: true })
    })
  })

  describe('session with history, same protocol', () => {
    it('allows switching to another model with the same protocol', () => {
      expect(
        resolveModelSwitchProtocol({
          modelId: 'krill/chat-4o',
          hasHistory: true,
          protocolMap: protocolMap({
            'krill/chat-4o': 'openai_responses',
            'krill/chat-4o-mini': 'openai_responses'
          }),
          currentProtocol: 'openai_responses'
        })
      ).toEqual({ allowed: true })
    })

    it('allows switching between providers that share the same protocol', () => {
      expect(
        resolveModelSwitchProtocol({
          modelId: 'openai/gpt-5',
          hasHistory: true,
          protocolMap: protocolMap({
            'krill/chat-4o': 'openai_responses',
            'openai/gpt-5': 'openai_responses'
          }),
          currentProtocol: 'openai_responses'
        })
      ).toEqual({ allowed: true })
    })

    it('allows switching back to the model already in use', () => {
      expect(
        resolveModelSwitchProtocol({
          modelId: 'krill/chat-4o',
          hasHistory: true,
          protocolMap: protocolMap({ 'krill/chat-4o': 'openai_responses' }),
          currentProtocol: 'openai_responses'
        })
      ).toEqual({ allowed: true })
    })
  })

  describe('session with history, cross protocol', () => {
    it('blocks switching and reports both real protocol names', () => {
      const result = resolveModelSwitchProtocol({
        modelId: 'krill/chat-4o',
        hasHistory: true,
        // map 值是 { protocol, efforts } 对象，必须读取 .protocol，不能把
        // 对象直接当字符串比较（回归：曾经渲染成 [object Object]）
        protocolMap: protocolMap({ 'krill/chat-4o': 'openai_responses' }),
        currentProtocol: 'openai_chat_completions'
      })
      expect(result.allowed).toBe(false)
      expect(result.reason).toContain('openai_chat_completions')
      expect(result.reason).toContain('openai_responses')
      expect(result.reason).not.toContain('[object Object]')
    })

    it('uses the CLI wording for the block reason', () => {
      const result = resolveModelSwitchProtocol({
        modelId: 'krill/chat-4o',
        hasHistory: true,
        protocolMap: protocolMap({ 'krill/chat-4o': 'openai_responses' }),
        currentProtocol: 'openai_chat_completions'
      })
      expect(result.reason).toBe(
        '当前会话使用 openai_chat_completions 协议，目标模型使用 openai_responses 协议；跨协议切换会丢失会话历史，请先新建会话或清空当前会话'
      )
    })
  })

  describe('session with history, undecidable protocol info (conservative pass)', () => {
    it('allows when the target model is not present in the map', () => {
      expect(
        resolveModelSwitchProtocol({
          modelId: 'unknown/model',
          hasHistory: true,
          protocolMap: protocolMap({ 'krill/chat-4o': 'openai_responses' }),
          currentProtocol: 'openai_responses'
        })
      ).toEqual({ allowed: true })
    })

    it('allows when the protocol map is not loaded', () => {
      expect(
        resolveModelSwitchProtocol({
          modelId: 'krill/chat-4o',
          hasHistory: true,
          protocolMap: null,
          currentProtocol: 'openai_responses'
        })
      ).toEqual({ allowed: true })
    })

    it('allows when the target model entry lacks a protocol field', () => {
      expect(
        resolveModelSwitchProtocol({
          modelId: 'krill/chat-4o',
          hasHistory: true,
          protocolMap: { 'krill/chat-4o': { efforts: ['medium'] } },
          currentProtocol: 'openai_responses'
        })
      ).toEqual({ allowed: true })
    })

    it('allows when the current protocol is unknown', () => {
      expect(
        resolveModelSwitchProtocol({
          modelId: 'krill/chat-4o',
          hasHistory: true,
          protocolMap: protocolMap({ 'krill/chat-4o': 'openai_responses' }),
          currentProtocol: ''
        })
      ).toEqual({ allowed: true })
    })
  })

  describe('plain-text fallback model list (protocol always present in app layer)', () => {
    it('still derives the protocol from the map entry object shape', () => {
      // mica-code-app 主进程 listModels 始终为每个模型附带 protocol，
      // 但兜底路径（旧版 CLI 纯文本）下 protocol 可能为默认值；
      // 只要与当前协议一致就放行，防止同协议误拦。
      expect(
        resolveModelSwitchProtocol({
          modelId: 'krill/chat-4o',
          hasHistory: true,
          protocolMap: protocolMap({ 'krill/chat-4o': 'openai_chat_completions' }),
          currentProtocol: 'openai_chat_completions'
        })
      ).toEqual({ allowed: true })
    })
  })
})
