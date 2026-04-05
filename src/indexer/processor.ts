import { ParsedTransactionWithMeta, PublicKey } from '@solana/web3.js';
import { config } from '../config';
import { createChildLogger } from '../utils/logger';
import { TransactionDecoder } from '../decoder';
import { AnchorIdl } from '../idl/types';
import { RpcClient } from './rpc-client';
import { getDb } from '../database/connection';
import {
  saveTransaction,
  saveInstruction,
  saveEvent,
  saveAccountState,
  getIndexerState,
  setIndexerState,
  TransactionRecord,
} from '../database/repository';
import { metrics } from '../observability/metrics';

const log = createChildLogger('processor');

const STATE_LAST_SIGNATURE = 'last_processed_signature';
const STATE_LAST_SLOT = 'last_processed_slot';

export interface BatchProcessStats {
  processed: number;
  decoded: number;
  errors: number;
  aborted: boolean;
  failedSignature: string | null;
}

interface ProcessBatchOptions {
  onProcessedSignature?: (signature: string) => Promise<void>;
}

/**
 * Transaction processor: decode → store pipeline with checkpointing.
 *
 * Design notes:
 * - Each tx is claimed through _transactions for idempotent processing.
 * - Transaction row, decoded instructions, decoded events, and checkpoints are persisted
 *   atomically inside one database transaction.
 * - Checkpoint updated after every committed tx for cold-start recovery.
 * - processingCount tracks in-flight work for graceful drain on shutdown.
 */
export class TransactionProcessor {
  private decoder: TransactionDecoder;
  private rpcClient: RpcClient;
  private idl: AnchorIdl;
  private isShuttingDown = false;
  private processingCount = 0;

  constructor(idl: AnchorIdl, rpcClient: RpcClient) {
    this.idl = idl;
    this.rpcClient = rpcClient;
    this.decoder = new TransactionDecoder(idl, config.solana.programId);
  }

  async processTransaction(tx: ParsedTransactionWithMeta, signature: string): Promise<number> {
    if (this.isShuttingDown) {
      log.warn('Shutdown in progress, skipping transaction');
      return 0;
    }

    this.processingCount++;

    try {
      const blockTime = tx.blockTime ? new Date(tx.blockTime * 1000) : null;
      const slot = tx.slot;
      const success = tx.meta?.err === null;

      const txRecord: TransactionRecord = {
        signature,
        slot,
        block_time: blockTime,
        success,
        err: tx.meta?.err ? JSON.stringify(tx.meta.err) : null,
      };
      const decodedInstructions = this.decoder.decodeTransaction(tx, signature);
      const decodedEvents = this.decoder.decodeEvents(tx, signature);
      const db = getDb();
      let alreadyIndexed = false;
      let savedInstructionCount = 0;
      let savedEventCount = 0;

      await db.transaction(async (trx) => {
        const claimed = await saveTransaction(txRecord, trx);
        if (!claimed) {
          alreadyIndexed = true;
          return;
        }

        for (const decoded of decodedInstructions) {
          await saveInstruction(
            this.idl, decoded.name, signature, slot, blockTime,
            decoded.instructionIndex, decoded.args, decoded.accounts, trx,
          );
          savedInstructionCount++;
        }

        for (const decodedEvent of decodedEvents) {
          await saveEvent(
            this.idl,
            decodedEvent.name,
            signature,
            slot,
            blockTime,
            decodedEvent.eventIndex,
            decodedEvent.data,
            trx,
          );
          savedEventCount++;
        }

        await setIndexerState(STATE_LAST_SIGNATURE, signature, trx);
        await setIndexerState(STATE_LAST_SLOT, slot.toString(), trx);
      });

      if (alreadyIndexed) {
        log.debug({ signature: signature.slice(0, 16) }, 'Already indexed, skipping');
        return 0;
      }

      if (success) {
        try {
          await this.refreshTouchedAccounts(tx, slot, signature);
        } catch (err) {
          log.warn(
            { error: (err as Error).message, signature: signature.slice(0, 16) },
            'Failed to refresh account state after transaction',
          );
        }
      }

      if (savedInstructionCount > 0 || savedEventCount > 0) {
        log.info(
          {
            signature: signature.slice(0, 16),
            slot,
            instructions: savedInstructionCount,
            events: savedEventCount,
          },
          'Processed transaction',
        );
      }

      metrics.incrementCounter('solana_indexer_transactions_processed_total', 1, {
        success,
      });
      metrics.incrementCounter('solana_indexer_decoded_records_total', savedInstructionCount + savedEventCount);
      metrics.setGauge('solana_indexer_last_processed_slot', slot);

      return savedInstructionCount + savedEventCount;
    } finally {
      this.processingCount--;
    }
  }

  async processBatch(signatures: string[], options: ProcessBatchOptions = {}): Promise<BatchProcessStats> {
    const stats: BatchProcessStats = {
      processed: 0,
      decoded: 0,
      errors: 0,
      aborted: false,
      failedSignature: null,
    };
    const batchSize = config.indexer.batchSize;

    for (let i = 0; i < signatures.length; i += batchSize) {
      if (this.isShuttingDown) {
        log.info('Shutdown requested, stopping batch');
        break;
      }

      const chunk = signatures.slice(i, i + batchSize);
      let transactions: (ParsedTransactionWithMeta | null)[];

      try {
        transactions = await this.rpcClient.getTransactionBatch(chunk);
      } catch (err) {
        log.error(
          {
            error: (err as Error).message,
            chunkStart: i,
            chunkSize: chunk.length,
          },
          'Failed to fetch transaction batch chunk',
        );
        stats.errors += 1;
        stats.aborted = true;
        stats.failedSignature = chunk[0] ?? null;
        log.info({ progress: `${Math.min(i + batchSize, signatures.length)}/${signatures.length}`, ...stats }, 'Batch progress');
        break;
      }

      for (let j = 0; j < transactions.length; j++) {
        const tx = transactions[j];
        if (!tx) {
          stats.errors++;
          stats.aborted = true;
          stats.failedSignature = chunk[j] ?? null;
          break;
        }

        try {
          const count = await this.processTransaction(tx, chunk[j]);
          stats.decoded += count;
          stats.processed++;
          if (options.onProcessedSignature) {
            await options.onProcessedSignature(chunk[j]);
          }
        } catch (err) {
          log.error({ error: (err as Error).message, signature: chunk[j]?.slice(0, 16) }, 'Failed to process tx');
          stats.errors++;
          stats.aborted = true;
          stats.failedSignature = chunk[j] ?? null;
          break;
        }
      }

      log.info({ progress: `${Math.min(i + batchSize, signatures.length)}/${signatures.length}`, ...stats }, 'Batch progress');
      if (stats.aborted) {
        metrics.incrementCounter('solana_indexer_batch_abort_total');
        log.warn(
          { failedSignature: stats.failedSignature, processed: stats.processed, errors: stats.errors },
          'Batch processing aborted to avoid advancing checkpoints past a failed transaction',
        );
        break;
      }
    }

    return stats;
  }

  async indexProgramAccounts(): Promise<number> {
    log.info('Indexing all program accounts...');
    const snapshotSlot = await this.rpcClient.getCurrentSlot();
    const accounts = await this.rpcClient.getProgramAccounts();
    let decoded = 0;

    for (const { pubkey, account } of accounts) {
      if (this.isShuttingDown) break;

      const decodedAccount = this.decoder.decodeAccountAuto(
        account.data, pubkey.toString(), account.owner.toString(), account.lamports, snapshotSlot,
      );

      if (decodedAccount) {
        try {
          decodedAccount.sourceKind = 'snapshot';
          decodedAccount.sourceRef = `snapshot:${snapshotSlot}`;
          await saveAccountState(this.idl, decodedAccount);
          decoded++;
        } catch (err) {
          log.warn({ error: (err as Error).message, pubkey: pubkey.toString() }, 'Failed to save account');
        }
      }
    }

    log.info({ total: accounts.length, decoded }, 'Account indexing complete');
    return decoded;
  }

  private async refreshTouchedAccounts(tx: ParsedTransactionWithMeta, slot: number, signature: string): Promise<void> {
    if (!this.idl.accounts || this.idl.accounts.length === 0) {
      return;
    }

    const accountKeys = this.extractAccountKeys(tx);
    if (accountKeys.length === 0) {
      return;
    }

    const pubkeys = accountKeys.map((key) => new PublicKey(key));
    const accountInfos = await this.rpcClient.getMultipleAccountsInfo(pubkeys);
    const programId = this.rpcClient.getProgramId().toBase58();
    let refreshed = 0;

    for (let i = 0; i < pubkeys.length; i++) {
      const accountInfo = accountInfos[i];
      if (!accountInfo) {
        continue;
      }

      if (accountInfo.executable || accountInfo.owner.toBase58() !== programId) {
        continue;
      }

      const decodedAccount = this.decoder.decodeAccountAuto(
        accountInfo.data,
        pubkeys[i].toBase58(),
        accountInfo.owner.toBase58(),
        accountInfo.lamports,
        slot,
      );

      if (!decodedAccount) {
        continue;
      }

      decodedAccount.signature = signature;
      decodedAccount.sourceKind = 'transaction';
      decodedAccount.sourceRef = `transaction:${signature}`;
      await saveAccountState(this.idl, decodedAccount);
      refreshed++;
    }

    if (refreshed > 0) {
      log.debug({ slot, refreshed }, 'Refreshed touched account state');
    }
  }

  private extractAccountKeys(tx: ParsedTransactionWithMeta): string[] {
    const keys = tx.transaction.message.accountKeys.map((key: any) => (
      typeof key === 'string'
        ? key
        : key.pubkey?.toString() ?? key.toString()
    ));
    const programId = this.rpcClient.getProgramId().toBase58();

    return Array.from(new Set(keys.filter((key) => key !== programId)));
  }

  async getLastProcessedSignature(): Promise<string | null> {
    return getIndexerState(STATE_LAST_SIGNATURE);
  }

  async getLastProcessedSlot(): Promise<number | null> {
    const raw = await getIndexerState(STATE_LAST_SLOT);
    if (!raw) return null;
    const parsed = Number.parseInt(raw, 10);
    return Number.isNaN(parsed) ? null : parsed;
  }

  requestShutdown(): void {
    this.isShuttingDown = true;
    log.info('Shutdown requested');
  }

  async waitForDrain(): Promise<void> {
    while (this.processingCount > 0) {
      log.info({ inFlight: this.processingCount }, 'Waiting for in-flight transactions');
      await new Promise((r) => setTimeout(r, 500));
    }
  }

  get shuttingDown(): boolean {
    return this.isShuttingDown;
  }
}
