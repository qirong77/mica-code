import { expect, it } from 'vitest';
import { appServerFailureFields } from './appServerDiagnostics.js';

it('records the method, stage and correlation without copying untrusted error details', () => {
  const fields = appServerFailureFields('mica/pluginPanel/view', 'request-1', -32603, new Error('/private/token secret'));
  expect(fields).toMatchObject({ method: 'mica/pluginPanel/view', requestId: 'request-1', phase: 'dispatch', category: 'request-error' });
  expect(JSON.stringify(fields)).not.toMatch(/private|token|secret/);
  expect(appServerFailureFields('/private/custom/method', 'request-2', -32601).method).toBe('unknown');
  expect(appServerFailureFields('turn/start', 'request-3', -32603, new DOMException('', 'AbortError')).category).toBe('cancelled');
});
