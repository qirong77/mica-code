export type SubmitResult =
  | { ok: true; handled?: boolean; queued?: boolean }
  | { ok: false; reason: 'busy' | 'empty' | 'command_failed' | 'error'; error?: unknown };

export type SubmitOptions = {
  source?: import('./RuntimeInput.js').RuntimeInputSource;
};
