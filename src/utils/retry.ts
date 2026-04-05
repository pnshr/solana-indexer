import { config } from '../config';
import { createChildLogger } from './logger';
import { metrics } from '../observability/metrics';

const log = createChildLogger('retry');

export class RetryError extends Error {
  constructor(
    message: string,
    public readonly attempts: number,
    public readonly lastError: Error,
  ) {
    super(message);
    this.name = 'RetryError';
  }
}

export interface RetryOptions {
  maxRetries?: number;
  shouldRetry?: (error: Error, attempt: number) => boolean;
}

/**
 * Exponential backoff with jitter.
 * delay = min(maxDelay, initialDelay * 2^attempt) + random ±25% jitter
 *
 * Jitter prevents "thundering herd" when multiple instances
 * retry the same RPC endpoint simultaneously.
 */
function calculateDelay(attempt: number): number {
  const { initialDelayMs, maxDelayMs } = config.retry;
  const exponential = initialDelayMs * Math.pow(2, attempt);
  const capped = Math.min(exponential, maxDelayMs);
  const jitter = capped * (0.75 + Math.random() * 0.5);
  return Math.round(jitter);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Execute `fn` with automatic retries and exponential backoff.
 * @param fn        — async function to execute
 * @param label     — descriptive label for log messages
 * @param overrideMaxRetries — override config.retry.maxRetries
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  label: string,
  overrideMaxRetries?: number | RetryOptions,
): Promise<T> {
  const options = typeof overrideMaxRetries === 'number'
    ? { maxRetries: overrideMaxRetries }
    : (overrideMaxRetries ?? {});
  const maxRetries = options.maxRetries ?? config.retry.maxRetries;
  let lastError: Error = new Error('Unknown error');

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));

      if (attempt === maxRetries) {
        metrics.incrementCounter('solana_indexer_rpc_retry_exhausted_total', 1, { label });
        log.error({ attempt, label, error: lastError.message }, 'All retry attempts exhausted');
        break;
      }

      if (options.shouldRetry && !options.shouldRetry(lastError, attempt + 1)) {
        metrics.incrementCounter('solana_indexer_rpc_retry_stopped_total', 1, { label });
        log.warn(
          { attempt: attempt + 1, maxRetries, label, error: lastError.message },
          'Stopping retries after non-retryable failure',
        );
        throw new RetryError(`${label}: failed after ${attempt + 1} attempts`, attempt + 1, lastError);
      }

      const delay = calculateDelay(attempt);
      metrics.incrementCounter('solana_indexer_rpc_retries_total', 1, { label });
      log.warn(
        { attempt: attempt + 1, maxRetries, delay, label, error: lastError.message },
        'Retrying after failure',
      );
      await sleep(delay);
    }
  }

  throw new RetryError(`${label}: failed after ${maxRetries + 1} attempts`, maxRetries + 1, lastError);
}
