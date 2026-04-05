import { config } from '../config';
import { createChildLogger } from '../utils/logger';
import { RpcClient } from './rpc-client';
import { TransactionProcessor } from './processor';
import { ConfirmedSignatureInfo } from '@solana/web3.js';
import { createHash } from 'crypto';
import { deleteIndexerState, getIndexerState, setIndexerState } from '../database/repository';
import { metrics } from '../observability/metrics';

const log = createChildLogger('batch-indexer');
const STATE_BATCH_CONTEXT = 'batch_checkpoint_context';
const STATE_BATCH_SIGNATURE = 'batch_checkpoint_signature';

/**
 * Batch indexer: historical transaction processing.
 *
 * Two modes:
 * 1. Signature list: process a provided list of tx signatures.
 * 2. Slot range: fetch all program signatures, optionally filter by slot range.
 *
 * Design note: slot-based filtering is client-side after fetching all signatures
 * because getSignaturesForAddress doesn't support slot-range queries.
 */
export class BatchIndexer {
  private rpcClient: RpcClient;
  private processor: TransactionProcessor;

  constructor(rpcClient: RpcClient, processor: TransactionProcessor) {
    this.rpcClient = rpcClient;
    this.processor = processor;
  }

  async run(): Promise<void> {
    log.info('Starting batch indexer');
    metrics.setLifecycleState('batch_running');

    // Mode 1: specific signatures
    if (config.indexer.batchSignatures && config.indexer.batchSignatures.length > 0) {
      const batchContext = this.buildBatchContext('signatures', config.indexer.batchSignatures);
      const resumableSignatures = await this.resumeBatchIfPossible(config.indexer.batchSignatures, batchContext);
      log.info({ count: resumableSignatures.length }, 'Processing specific signatures');
      const stats = await this.processor.processBatch(resumableSignatures, {
        onProcessedSignature: async (signature) => {
          await this.persistBatchCheckpoint(batchContext, signature);
        },
      });
      if (stats.aborted) {
        throw new Error(`Batch aborted at signature ${stats.failedSignature ?? 'unknown'}`);
      }
      await this.clearBatchCheckpoint();
      log.info(stats, 'Batch complete (signature list)');
      metrics.setLifecycleState('batch_complete');
      return;
    }

    // Mode 2: paginated historical scan with optional slot bounds.
    log.info(
      {
        startSlot: config.indexer.batchStartSlot,
        endSlot: config.indexer.batchEndSlot,
      },
      'Fetching program signatures for slot-based batch indexing',
    );
    const signatures = await this.collectSignaturesForBatchRange();

    // Reverse for chronological processing
    signatures.reverse();
    const sigs = signatures.map((s) => s.signature);
    const batchContext = this.buildBatchContext('slot-range', sigs);
    const resumableSignatures = await this.resumeBatchIfPossible(sigs, batchContext);

    log.info({ count: resumableSignatures.length }, 'Signatures to process');

    if (resumableSignatures.length === 0) {
      log.info('No signatures found');
      await this.clearBatchCheckpoint();
      metrics.setLifecycleState('batch_complete');
      return;
    }

    const stats = await this.processor.processBatch(resumableSignatures, {
      onProcessedSignature: async (signature) => {
        await this.persistBatchCheckpoint(batchContext, signature);
      },
    });
    if (stats.aborted) {
      throw new Error(`Batch aborted at signature ${stats.failedSignature ?? 'unknown'}`);
    }
    await this.clearBatchCheckpoint();
    log.info(stats, 'Batch indexing complete');

    // Also snapshot account states
    const accountCount = await this.processor.indexProgramAccounts();
    log.info({ accountCount }, 'Account state indexing complete');
    metrics.setLifecycleState('batch_complete');
  }

  private async collectSignaturesForBatchRange() {
    const matches: ConfirmedSignatureInfo[] = [];
    let before: string | undefined;
    // Counts consecutive pages where every signature is above batchEndSlot.
    // Used to warn once when the scan is traversing a large amount of "too-new"
    // history. getSignaturesForAddress has no server-side slot filter, so we
    // must page through all history newer than batchEndSlot.
    let pagesAboveEndSlot = 0;

    while (true) {
      const batch = await this.rpcClient.getSignatures({ before, limit: 1000 });
      if (batch.length === 0) {
        break;
      }

      let pageMatches = 0;
      for (const signature of batch) {
        if (config.indexer.batchEndSlot !== undefined && signature.slot > config.indexer.batchEndSlot) {
          continue;
        }
        if (config.indexer.batchStartSlot !== undefined && signature.slot < config.indexer.batchStartSlot) {
          continue;
        }
        matches.push(signature);
        pageMatches++;
      }

      const oldestSignature = batch[batch.length - 1];

      if (config.indexer.batchEndSlot !== undefined && oldestSignature.slot > config.indexer.batchEndSlot) {
        pagesAboveEndSlot++;
        if (pagesAboveEndSlot === 10) {
          log.warn(
            { batchEndSlot: config.indexer.batchEndSlot, currentOldestSlot: oldestSignature.slot },
            'Still scanning pages above BATCH_END_SLOT — this can require many RPC calls when '
            + 'the target slot is far in the past. Consider using BATCH_SIGNATURES instead.',
          );
        }
      } else {
        pagesAboveEndSlot = 0;
      }

      log.debug(
        {
          fetched: batch.length,
          pageMatches,
          totalMatched: matches.length,
          oldestSlot: oldestSignature.slot,
        },
        'Fetched signature page for batch range',
      );

      if (config.indexer.batchStartSlot !== undefined && oldestSignature.slot < config.indexer.batchStartSlot) {
        break;
      }

      if (batch.length < 1000) {
        break;
      }

      before = oldestSignature.signature;
    }

    return matches;
  }

  private buildBatchContext(kind: 'signatures' | 'slot-range', signatures: string[]): string {
    const payload = JSON.stringify({
      kind,
      programId: this.rpcClient.getProgramId().toBase58(),
      batchStartSlot: config.indexer.batchStartSlot ?? null,
      batchEndSlot: config.indexer.batchEndSlot ?? null,
      signaturesHash: createHash('sha1').update(signatures.join(',')).digest('hex'),
    });

    return createHash('sha256').update(payload).digest('hex');
  }

  private async resumeBatchIfPossible(signatures: string[], batchContext: string): Promise<string[]> {
    if (!config.indexer.batchResume || signatures.length === 0) {
      return signatures;
    }

    const [storedContext, storedSignature] = await Promise.all([
      getIndexerState(STATE_BATCH_CONTEXT),
      getIndexerState(STATE_BATCH_SIGNATURE),
    ]);

    if (storedContext && storedContext !== batchContext) {
      await this.clearBatchCheckpoint();
      return signatures;
    }

    if (!storedSignature || storedContext !== batchContext) {
      return signatures;
    }

    const checkpointIndex = signatures.indexOf(storedSignature);
    if (checkpointIndex === -1) {
      log.warn({ storedSignature: storedSignature.slice(0, 16) }, 'Stored batch checkpoint not found in current run, starting from the beginning');
      return signatures;
    }

    const remaining = signatures.slice(checkpointIndex + 1);
    if (remaining.length === 0) {
      await this.clearBatchCheckpoint();
      return remaining;
    }

    metrics.incrementCounter('solana_indexer_batch_resume_total');
    log.info(
      {
        resumedAfter: storedSignature.slice(0, 16),
        skipped: checkpointIndex + 1,
        remaining: remaining.length,
      },
      'Resuming batch from checkpoint',
    );
    return remaining;
  }

  private async persistBatchCheckpoint(batchContext: string, signature: string): Promise<void> {
    await setIndexerState(STATE_BATCH_CONTEXT, batchContext);
    await setIndexerState(STATE_BATCH_SIGNATURE, signature);
  }

  private async clearBatchCheckpoint(): Promise<void> {
    await Promise.all([
      deleteIndexerState(STATE_BATCH_CONTEXT),
      deleteIndexerState(STATE_BATCH_SIGNATURE),
    ]);
  }
}
