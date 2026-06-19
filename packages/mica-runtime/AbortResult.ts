export type AbortResult = { ok: true } | { ok: false; reason: 'not_running' | 'error'; error?: unknown };
