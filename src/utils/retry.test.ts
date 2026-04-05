import { withRetry, RetryError } from './retry';

// Mock config
jest.mock('../config', () => ({
  config: {
    logLevel: 'error',
    retry: {
      maxRetries: 3,
      initialDelayMs: 10, // Short delays for tests
      maxDelayMs: 100,
    },
  },
}));

describe('Retry Utility', () => {
  it('returns immediately on success', async () => {
    const fn = jest.fn().mockResolvedValue('ok');
    const result = await withRetry(fn, 'test');

    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('retries on failure and eventually succeeds', async () => {
    const fn = jest
      .fn()
      .mockRejectedValueOnce(new Error('fail 1'))
      .mockRejectedValueOnce(new Error('fail 2'))
      .mockResolvedValue('ok');

    const result = await withRetry(fn, 'test');

    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('throws RetryError after all attempts exhausted', async () => {
    const fn = jest.fn().mockRejectedValue(new Error('always fails'));

    await expect(withRetry(fn, 'test')).rejects.toThrow(RetryError);
    // 1 initial + 3 retries = 4 calls
    expect(fn).toHaveBeenCalledTimes(4);
  });

  it('respects overrideMaxRetries', async () => {
    const fn = jest.fn().mockRejectedValue(new Error('fails'));

    await expect(withRetry(fn, 'test', 1)).rejects.toThrow(RetryError);
    // 1 initial + 1 retry = 2 calls
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('preserves the last error in RetryError', async () => {
    const fn = jest
      .fn()
      .mockRejectedValueOnce(new Error('first'))
      .mockRejectedValueOnce(new Error('second'))
      .mockRejectedValueOnce(new Error('third'))
      .mockRejectedValueOnce(new Error('fourth'));

    try {
      await withRetry(fn, 'test');
      fail('Should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(RetryError);
      expect((err as RetryError).lastError.message).toBe('fourth');
      expect((err as RetryError).attempts).toBe(4);
    }
  });

  it('stops immediately when shouldRetry marks an error as non-retryable', async () => {
    const fn = jest.fn().mockRejectedValue(new Error('do not retry'));

    try {
      await withRetry(fn, 'test', {
        shouldRetry: (error) => error.message !== 'do not retry',
      });
      fail('Should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(RetryError);
      expect((err as RetryError).lastError.message).toBe('do not retry');
      expect((err as RetryError).attempts).toBe(1);
    }

    expect(fn).toHaveBeenCalledTimes(1);
  });
});
