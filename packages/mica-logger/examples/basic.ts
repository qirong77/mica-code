import { micaLogger } from '../index.js';

micaLogger.logRuntime('example', 'started', { ok: true });

for (const entry of micaLogger.logs.get()) {
  console.log(micaLogger.formatLogEntry(entry));
}
