import {
  Connection,
  PublicKey,
  ConfirmedSignatureInfo,
  ParsedTransactionWithMeta,
  AccountInfo,
} from '@solana/web3.js';
import { config } from '../config';
import { sleep, withRetry, RetryError } from '../utils/retry';
import { createChildLogger } from '../utils/logger';

const log = createChildLogger('rpc-client');

/**
 * Wrapper around Solana Connection with automatic retry + exponential backoff.
 *
 * Design notes:
 * - getSignaturesForAddress has a 1000-per-call limit; pagination via `before`.
 * - getParsedTransactions batches in chunks of 10 to avoid rate limits.
 * - Every RPC call goes through withRetry for resilience.
 */
export class RpcClient {
  private connection: Connection;
  private programId: PublicKey;
  private batchTransactionRequestsEnabled = true;

  constructor() {
    this.connection = new Connection(config.solana.rpcUrl, {
      commitment: 'confirmed',
      wsEndpoint: config.solana.wsUrl,
    });
    this.programId = new PublicKey(config.solana.programId);
    log.info({ rpcUrl: config.solana.rpcUrl, programId: config.solana.programId }, 'RPC client initialized');
  }

  getConnection(): Connection {
    return this.connection;
  }

  getProgramId(): PublicKey {
    return this.programId;
  }

  async getSignatures(options: { before?: string; until?: string; limit?: number } = {}): Promise<ConfirmedSignatureInfo[]> {
    return withRetry(
      () => this.connection.getSignaturesForAddress(this.programId, {
        before: options.before,
        until: options.until,
        limit: options.limit || 1000,
      }),
      'getSignaturesForAddress',
    );
  }

  /**
   * Fetch ALL signatures since a given point, handling pagination automatically.
   * Returns newest → oldest. Caller should reverse for chronological order.
   */
  async getAllSignaturesSince(untilSignature?: string): Promise<ConfirmedSignatureInfo[]> {
    const all: ConfirmedSignatureInfo[] = [];
    let before: string | undefined;

    while (true) {
      const batch = await this.getSignatures({ before, until: untilSignature, limit: 1000 });
      if (batch.length === 0) break;

      all.push(...batch);
      before = batch[batch.length - 1].signature;

      log.debug({ fetched: batch.length, total: all.length }, 'Fetched signature page');

      if (batch.length < 1000) break;
    }

    return all;
  }

  async getTransaction(signature: string): Promise<ParsedTransactionWithMeta | null> {
    return withRetry(
      () => this.connection.getParsedTransaction(signature, { maxSupportedTransactionVersion: 0 }),
      `getTransaction(${signature.slice(0, 8)}...)`,
    );
  }

  /**
   * Fetch multiple parsed transactions in chunks.
   * Default chunk size 10 to avoid overwhelming RPC.
   */
  async getTransactionBatch(signatures: string[], chunkSize = 10): Promise<(ParsedTransactionWithMeta | null)[]> {
    const results: (ParsedTransactionWithMeta | null)[] = [];

    for (let i = 0; i < signatures.length; i += chunkSize) {
      const chunk = signatures.slice(i, i + chunkSize);

      if (!this.batchTransactionRequestsEnabled || chunk.length === 1) {
        await this.fetchTransactionsIndividually(chunk, results);
        log.debug({ processed: results.length, total: signatures.length }, 'Transaction batch progress');
        continue;
      }

      try {
        const chunkResults = await withRetry(
          () => this.connection.getParsedTransactions(chunk, { maxSupportedTransactionVersion: 0 }),
          `getTransactionBatch(${i}..${i + chunk.length})`,
          {
            shouldRetry: (error) => !this.isNonRetryableBatchError(error),
          },
        );
        results.push(...chunkResults);
      } catch (err) {
        const rpcError = err instanceof RetryError
          ? err.lastError
          : (err instanceof Error ? err : new Error(String(err)));
        const nonRetryableBatchError = this.isNonRetryableBatchError(rpcError);

        if (nonRetryableBatchError) {
          this.batchTransactionRequestsEnabled = false;
        }

        log.warn(
          { error: rpcError.message, chunkStart: i, chunkSize: chunk.length },
          nonRetryableBatchError
            ? 'Batch transaction fetch is not available on this RPC plan, falling back to individual requests'
            : 'Batch transaction fetch failed, falling back to individual requests',
        );

        await this.fetchTransactionsIndividually(chunk, results);
      }

      log.debug({ processed: results.length, total: signatures.length }, 'Transaction batch progress');
    }

    return results;
  }

  async getAccountInfo(pubkey: PublicKey): Promise<AccountInfo<Buffer> | null> {
    return withRetry(
      () => this.connection.getAccountInfo(pubkey),
      `getAccountInfo(${pubkey.toString().slice(0, 8)}...)`,
    );
  }

  async getMultipleAccountsInfo(pubkeys: PublicKey[], chunkSize = 100): Promise<(AccountInfo<Buffer> | null)[]> {
    const results: (AccountInfo<Buffer> | null)[] = [];

    for (let i = 0; i < pubkeys.length; i += chunkSize) {
      const chunk = pubkeys.slice(i, i + chunkSize);
      const chunkResults = await withRetry(
        () => this.connection.getMultipleAccountsInfo(chunk),
        `getMultipleAccountsInfo(${i}..${i + chunk.length})`,
      );
      results.push(...chunkResults);
    }

    return results;
  }

  async getProgramAccounts(): Promise<{ pubkey: PublicKey; account: AccountInfo<Buffer> }[]> {
    const accounts = await withRetry(
      () => this.connection.getProgramAccounts(this.programId, { commitment: 'confirmed' }),
      'getProgramAccounts',
    );

    return Array.from(accounts);
  }

  async getCurrentSlot(): Promise<number> {
    return withRetry(
      () => this.connection.getSlot('confirmed'),
      'getSlot',
    );
  }

  private isNonRetryableBatchError(error: Error): boolean {
    const message = error.message.toLowerCase();
    return message.includes('batch requests are only available for paid plans')
      || message.includes('"code":-32403');
  }

  private async fetchTransactionsIndividually(
    signatures: string[],
    results: (ParsedTransactionWithMeta | null)[],
  ): Promise<void> {
    for (const signature of signatures) {
      results.push(await this.getTransaction(signature));
      await sleep(200);
    }
  }
}
