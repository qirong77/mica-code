/**
 * Codex exec-style ThreadEvent JSONL (`mica exec --json`).
 *
 * Mirrors the event shapes emitted by `codex exec --json` (see
 * codex-rs/exec/src/exec_events.rs in the OpenAI codex repository):
 * one JSON object per line, top-level `type` discriminator, and items tagged
 * by `type` with snake_case names. Consumers that already parse codex exec
 * output can consume `mica exec --json` without changes.
 */

export type CodexExecUsage = {
  input_tokens: number;
  cached_input_tokens: number;
  cache_write_input_tokens: number;
  output_tokens: number;
  reasoning_output_tokens: number;
};

export type CodexExecItem =
  | { id: string; type: 'agent_message'; text: string }
  | { id: string; type: 'reasoning'; text: string }
  | {
      id: string;
      type: 'command_execution';
      command: string;
      aggregated_output: string;
      exit_code: number | null;
      status: 'in_progress' | 'completed' | 'failed' | 'declined';
    }
  | { id: string; type: 'error'; message: string };

export type CodexExecEvent =
  | { type: 'thread.started'; thread_id: string }
  | { type: 'turn.started' }
  | { type: 'turn.completed'; usage: CodexExecUsage }
  | { type: 'turn.failed'; error: { message: string } }
  | { type: 'item.started'; item: CodexExecItem }
  | { type: 'item.updated'; item: CodexExecItem }
  | { type: 'item.completed'; item: CodexExecItem }
  | { type: 'error'; message: string };

export type CodexExecEventWriter = {
  write(event: CodexExecEvent): void;
};

export function encodeCodexExecLine(event: CodexExecEvent): string {
  return `${JSON.stringify(event)}\n`;
}

export function createStdoutCodexExecWriter(
  write: (chunk: string) => void = (chunk) => {
    process.stdout.write(chunk);
  },
): CodexExecEventWriter {
  return {
    write(event) {
      write(encodeCodexExecLine(event));
    },
  };
}

export function emptyCodexExecUsage(): CodexExecUsage {
  return {
    input_tokens: 0,
    cached_input_tokens: 0,
    cache_write_input_tokens: 0,
    output_tokens: 0,
    reasoning_output_tokens: 0,
  };
}
