import type Anthropic from '@anthropic-ai/sdk';
import type { Stream } from '@anthropic-ai/sdk/streaming.mjs';

type RawEvent = Anthropic.Messages.RawMessageStreamEvent;

type Listener = (...args: any[]) => void;

export class RawStreamProcessor {
  private _listeners: Record<string, Listener[]> = {};
  private _abortController: AbortController;
  private _ended = false;
  private _finalMessage: Anthropic.Message | null = null;

  constructor(abortController: AbortController) {
    this._abortController = abortController;
  }

  get controller(): AbortController {
    return this._abortController;
  }

  on(event: string, listener: Listener): this {
    (this._listeners[event] ??= []).push(listener);
    return this;
  }

  async finalMessage(): Promise<Anthropic.Message> {
    if (!this._finalMessage) {
      throw new Error('Stream not yet complete');
    }
    return this._finalMessage;
  }

  private _emit(event: string, ...args: any[]): void {
    if (this._ended) return;
    if (event === 'end') this._ended = true;
    const listeners = this._listeners[event] ?? [];
    for (const fn of listeners) fn(...args);
  }

  async process(rawStream: Stream<RawEvent>): Promise<void> {
    const contentBlocks: Array<{
      type: string;
      textParts?: string[];
      text?: string;
      thinking?: string;
      signature?: string;
      id?: string;
      name?: string;
      inputRaw?: string;
      input?: Record<string, any>;
      index?: number;
    }> = [];

    let messageStart: any = null;
    let stopReason: string | null = null;
    let usage: Record<string, number> = { input_tokens: 0, output_tokens: 0 };

    try {
      for await (const event of rawStream) {
        switch (event.type) {
          case 'message_start': {
            messageStart = event.message;
            usage = { ...(event.message.usage as any) };
            break;
          }

          case 'content_block_start': {
            const block = event.content_block;
            if (event.index >= contentBlocks.length) {
              contentBlocks.push({
                type: block.type,
                index: event.index,
              });
            }
            const cb = contentBlocks[event.index];
            cb.type = block.type;

            if (block.type === 'tool_use') {
              cb.id = block.id;
              cb.name = block.name;
              cb.inputRaw = '';
              cb.input = {};
            } else if (block.type === 'text') {
              cb.textParts = [];
              cb.text = '';
            } else if (block.type === 'thinking') {
              cb.thinking = '';
              cb.signature = '';
            }
            break;
          }

          case 'content_block_delta': {
            const cb = contentBlocks[event.index];
            if (!cb) break;

            const delta = event.delta;
            if (!delta) break;

            if (delta.type === 'text_delta' && typeof (delta as any).text === 'string') {
              const text = (delta as any).text;
              if (cb.type === 'text') {
                cb.textParts!.push(text);
                this._emit('text', text, cb.text || '');
              }
            } else if (delta.type === 'input_json_delta' && (delta as any).partial_json) {
              if (cb.type === 'tool_use') {
                cb.inputRaw = (cb.inputRaw || '') + (delta as any).partial_json;
              }
            } else if (delta.type === 'thinking_delta' && (delta as any).thinking) {
              if (cb.type === 'thinking') {
                cb.thinking = (cb.thinking || '') + (delta as any).thinking;
                this._emit('thinking', (delta as any).thinking, cb.thinking);
              }
            } else if (delta.type === 'signature_delta' && (delta as any).signature) {
              if (cb.type === 'thinking') {
                cb.signature = (delta as any).signature;
              }
            }
            break;
          }

          case 'content_block_stop': {
            const cb = contentBlocks[event.index];
            if (!cb) break;

            if (cb.type === 'text') {
              cb.text = (cb.textParts || []).join('');
            } else if (cb.type === 'tool_use') {
              if (cb.inputRaw) {
                try {
                  cb.input = JSON.parse(cb.inputRaw);
                } catch {
                  cb.input = {};
                }
              }
            }

            this._emit('contentBlock', {
              type: cb.type,
              ...(cb.type === 'tool_use' ? { id: cb.id, name: cb.name, input: cb.input } : {}),
              ...(cb.type === 'text' ? { text: cb.text } : {}),
              ...(cb.type === 'thinking' ? { thinking: cb.thinking, signature: cb.signature } : {}),
            });
            break;
          }

          case 'message_delta': {
            stopReason = event.delta.stop_reason ?? null;
            usage.output_tokens = event.usage?.output_tokens ?? usage.output_tokens;
            break;
          }

          case 'message_stop': {
            break;
          }
        }
      }

      const content: any[] = [];
      for (const cb of contentBlocks) {
        if (cb.type === 'text') {
          content.push({ type: 'text', text: cb.text || (cb.textParts || []).join('') });
        } else if (cb.type === 'tool_use') {
          content.push({
            type: 'tool_use',
            id: cb.id!,
            name: cb.name!,
            input: cb.input || {},
          });
        } else if (cb.type === 'thinking') {
          content.push({
            type: 'thinking',
            thinking: cb.thinking || '',
            signature: cb.signature || '',
          });
        }
      }

      this._finalMessage = {
        id: messageStart?.message?.id ?? 'msg_unknown',
        type: 'message',
        role: 'assistant',
        content,
        model: messageStart?.message?.model ?? '',
        stop_reason: stopReason as any,
        stop_sequence: null,
        usage: usage as any,
      } as Anthropic.Message;
    } catch (err: any) {
      if (err?.name === 'AbortError' || this._abortController.signal.aborted) return;
      if (err?.message === 'ABORT') return;
      throw err;
    }
  }
}
