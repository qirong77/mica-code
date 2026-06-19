import { EventEmitter } from 'node:events';
import type { Socket } from 'node:net';
import type { RpcMessage } from './protocol.js';

export class JsonLineConnection extends EventEmitter<{
  message: [RpcMessage];
  error: [unknown];
  close: [];
}> {
  private buffer = '';

  constructor(private readonly socket: Socket) {
    super();
    socket.setEncoding('utf8');
    socket.on('data', (chunk) => this.accept(String(chunk)));
    socket.on('error', (error) => this.emit('error', error));
    socket.on('close', () => this.emit('close'));
  }

  send(message: RpcMessage): void {
    this.socket.write(`${JSON.stringify(message)}\n`);
  }

  close(): void {
    this.socket.end();
  }

  private accept(chunk: string): void {
    this.buffer += chunk;
    while (true) {
      const newline = this.buffer.indexOf('\n');
      if (newline < 0) return;
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (!line) continue;
      try {
        this.emit('message', JSON.parse(line) as RpcMessage);
      } catch (error) {
        this.emit('error', error);
      }
    }
  }
}
