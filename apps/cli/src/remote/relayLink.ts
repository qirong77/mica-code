import {
  parseRelayFrame,
  REMOTE_LIMITS,
  type RelayFrame,
  type RelayHelloFrame,
} from '@packages/mica-remote-protocol/index.js';

export type RelayLinkOptions = {
  wsUrl: string;
  hello: RelayHelloFrame;
  onFrame(frame: RelayFrame): void;
  onClose?(): void;
  heartbeatMs?: number;
  maxReconnectMs?: number;
};

/**
 * One authenticated outbound WebSocket.
 *
 * The machine keeps this link open while remote access is enabled; controllers
 * open it only while a command or subscription is active. Reconnect uses
 * exponential backoff and never replays requests — callers own their pending
 * request bookkeeping.
 */
export class RelayLink {
  private socket: WebSocket | null = null;
  private stopped = false;
  private helloDone = false;
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectDelay: number;
  private connectPromise: Promise<void> | null = null;
  private resolveConnect: (() => void) | null = null;
  private rejectConnect: ((error: Error) => void) | null = null;

  constructor(private readonly options: RelayLinkOptions) {
    this.reconnectDelay = 1000;
  }

  get connected(): boolean {
    return Boolean(this.socket && this.helloDone);
  }

  connect(): Promise<void> {
    if (this.connectPromise) return this.connectPromise;
    this.stopped = false;
    this.connectPromise = new Promise<void>((resolve, reject) => {
      this.resolveConnect = resolve;
      this.rejectConnect = reject;
      this.open();
    });
    return this.connectPromise;
  }

  private open(): void {
    if (this.stopped) return;
    const socket = new WebSocket(this.options.wsUrl);
    this.socket = socket;
    socket.addEventListener('open', () => {
      this.sendRaw({ ...this.options.hello, v: 1 });
    });
    socket.addEventListener('message', (event) => {
      const raw = typeof event.data === 'string' ? event.data : '';
      if (!raw) return;
      let frame: RelayFrame;
      try {
        frame = parseRelayFrame(raw);
      } catch {
        return;
      }
      if (frame.t === 'hello.ok') {
        this.helloDone = true;
        this.reconnectDelay = 1000;
        this.startHeartbeat();
        this.resolveConnect?.();
        this.resolveConnect = null;
        this.rejectConnect = null;
        this.options.onFrame(frame);
        return;
      }
      if (frame.t === 'error' && !this.helloDone) {
        this.fail(new Error(frame.message));
        try {
          socket.close(1008, 'handshake failed');
        } catch {
          // ignore
        }
        return;
      }
      if (!this.helloDone) return;
      this.options.onFrame(frame);
    });
    socket.addEventListener('close', () => {
      this.helloDone = false;
      this.stopHeartbeat();
      this.socket = null;
      if (!this.stopped) {
        this.rejectConnect?.(new Error('与中转机的连接已断开'));
        this.rejectConnect = null;
        this.resolveConnect = null;
        this.options.onClose?.();
        this.scheduleReconnect();
      }
    });
    socket.addEventListener('error', () => {
      // The close event carries the actionable state; avoid double reporting.
    });
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer || this.stopped) return;
    const delay = this.reconnectDelay;
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, this.options.maxReconnectMs ?? 15_000);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connectPromise = null;
      void this.connect().catch(() => {
        // A failed attempt schedules the next one from its close handler.
      });
    }, delay);
  }

  send(frame: RelayFrame): boolean {
    if (!this.socket || !this.helloDone) return false;
    return this.sendRaw(frame);
  }

  private sendRaw(frame: RelayFrame): boolean {
    if (!this.socket || this.socket.readyState !== 1) return false;
    const text = JSON.stringify(frame);
    if (Buffer.byteLength(text, 'utf8') > REMOTE_LIMITS.maxFrameBytes) {
      throw new Error('message exceeds the relay frame limit');
    }
    this.socket.send(text);
    return true;
  }

  close(): void {
    this.stopped = true;
    this.helloDone = false;
    this.stopHeartbeat();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    try {
      this.socket?.close(1000, 'bye');
    } catch {
      // ignore
    }
    this.socket = null;
    this.fail(new Error('连接已关闭'));
  }

  private fail(error: Error): void {
    this.rejectConnect?.(error);
    this.rejectConnect = null;
    this.resolveConnect = null;
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeat = setInterval(() => {
      this.send({ v: 1, t: 'ping', at: new Date().toISOString() });
    }, this.options.heartbeatMs ?? REMOTE_LIMITS.heartbeatMs);
    this.heartbeat.unref?.();
  }

  private stopHeartbeat(): void {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
  }
}
