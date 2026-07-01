import { describe, expect, it } from 'vitest';
import { isRetryableError } from './retry.js';

describe('isRetryableError', () => {
  it('treats overloaded server messages as retryable', () => {
    expect(isRetryableError(new Error('Our servers are currently overloaded. Please try again later.'))).toBe(true);
  });

  it('treats provider retryable error codes as retryable', () => {
    expect(isRetryableError(Object.assign(new Error('server is busy'), { code: 'overloaded' }))).toBe(true);
    expect(isRetryableError(Object.assign(new Error('rate limited'), { code: 'rate_limit_exceeded' }))).toBe(true);
  });

  it('does not retry aborts', () => {
    const error = new Error('Agent query aborted');
    error.name = 'AbortError';

    expect(isRetryableError(error)).toBe(false);
  });
});
