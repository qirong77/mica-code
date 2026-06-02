import type Anthropic from '@anthropic-ai/sdk'
import {
  messagesAtom,
  contextSizeAtom,
  updateContextSize,
  type ConversationMessage,
} from '../store/conversation.js'

export class ConversationStore {
  getMessages(): ConversationMessage[] {
    return messagesAtom.get()
  }

  set(messages: ConversationMessage[]): void {
    messagesAtom.set(messages)
  }

  appendUser(content: Anthropic.MessageParam['content']): void {
    const updated: ConversationMessage[] = [
      ...messagesAtom.get(),
      { role: 'user', content },
    ]
    messagesAtom.set(updated)
  }

  appendAssistant(message: Anthropic.Message): void {
    const messages = messagesAtom.get()
    const updated = [...messages, message]
    messagesAtom.set(updated)
    contextSizeAtom.set(updateContextSize(updated))
  }

  appendToolResults(toolResults: Anthropic.ToolResultBlockParam[]): void {
    const updated: ConversationMessage[] = [
      ...messagesAtom.get(),
      { role: 'user', content: toolResults },
    ]
    messagesAtom.set(updated)
  }
}
