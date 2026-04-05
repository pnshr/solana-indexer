import { Logs } from '@solana/web3.js';
import { createChildLogger } from '../utils/logger';
import { RpcClient } from './rpc-client';
import { TransactionProcessor } from './processor';
import { sleep } from '../utils/retry';
import { config } from '../config';
import { metrics } from '../observability/metrics';

const log = createChildLogger('realtime-indexer');

/**
 * Realtime indexer with cold start support.
 *
 * Lifecycle:
 * 1. Subscribe to program logs immediately so new transactions arriving during
 *    startup can be queued instead of missed.
 * 2. Cold start: fetch all transactions since the last processed signature and
 *    process them in chronological order.
 * 3. Flush any queued signatures captured during cold start.
 * 4. Keep the websocket subscription running for realtime processing.
 */
export class RealtimeIndexer {
  private rpcClient: RpcClient;
  private processor: TransactionProcessor;
  private subscriptionId: number | null = null;
  private pendingSignatures: string[] = [];
  private isGapFilling = false;
  private isRunning = false;
  // Serialize realtime transaction handling to avoid concurrent DB writes and
  // out-of-order processing when multiple logs arrive at once.
  private realtimeQueue: Promise<void> = Promise.resolve();

  constructor(rpcClient: RpcClient, processor: TransactionProcessor) {
    this.rpcClient = rpcClient;
    this.processor = processor;
  }

  async start(): Promise<void> {
    this.isRunning = true;
    metrics.setLifecycleState('realtime_gap_fill');
    log.info('Starting realtime indexer');

    // Subscribe first so signatures arriving during gap fill are queued.
    this.isGapFilling = true;
    await this.subscribe();

    if (!this.isRunning) {
      this.isGapFilling = false;
      return;
    }

    await this.coldStart();
    await this.flushPendingSignatures('Processing transactions queued during cold start');

    try {
      await this.processor.indexProgramAccounts();
    } catch (err) {
      log.warn({ error: (err as Error).message }, 'Failed to index program accounts');
    }

    await this.updateLagMetrics();
    metrics.setLifecycleState('realtime_live');
    log.info('Realtime indexer is now live');
    await this.keepAlive();
  }

  private async coldStart(): Promise<void> {
    const lastSignature = await this.processor.getLastProcessedSignature();

    if (lastSignature) {
      log.info(
        { lastSignature: lastSignature.slice(0, 16) },
        'Cold start: filling gap since last processed signature',
      );
    } else {
      log.info('Cold start: no previous checkpoint, fetching recent history');
    }

    try {
      const signatures = await this.rpcClient.getAllSignaturesSince(lastSignature || undefined);

      if (signatures.length === 0) {
        log.info('No gap to fill - already up to date');
        return;
      }

      signatures.reverse();
      log.info({ count: signatures.length }, 'Gap-fill: processing missed transactions');

      const sigs = signatures.map((s) => s.signature);
      const stats = await this.processor.processBatch(sigs);
      if (stats.aborted) {
        throw new Error(`Gap-fill aborted at signature ${stats.failedSignature ?? 'unknown'}`);
      }

      log.info(stats, 'Gap-fill complete');
    } catch (err) {
      log.error({ error: (err as Error).message }, 'Cold start gap-fill failed');
      throw err;
    } finally {
      this.isGapFilling = false;
    }
  }

  private async subscribe(): Promise<void> {
    if (this.subscriptionId !== null) {
      return;
    }

    const connection = this.rpcClient.getConnection();
    const programId = this.rpcClient.getProgramId();

    log.info({ programId: programId.toString() }, 'Subscribing to program logs');

    this.subscriptionId = connection.onLogs(
      programId,
      (logs: Logs) => {
        const signature = logs.signature;

        if (this.isGapFilling) {
          this.pendingSignatures.push(signature);
          metrics.setGauge('solana_indexer_realtime_queue_size', this.pendingSignatures.length);
          log.debug({ signature: signature.slice(0, 16) }, 'Queued transaction during gap-fill');
          return;
        }

        this.realtimeQueue = this.realtimeQueue
          .then(async () => {
            if (!this.isRunning || this.isGapFilling) return;
            const tx = await this.rpcClient.getTransaction(signature);
            if (tx) {
              await this.processor.processTransaction(tx, signature);
              await this.updateLagMetrics();
            }
          })
          .catch((err) => {
            log.error(
              { error: (err as Error).message, signature: signature.slice(0, 16) },
              'Failed to process realtime transaction',
            );
          });
      },
      'confirmed',
    );

    log.info({ subscriptionId: this.subscriptionId }, 'WebSocket subscription active');
  }

  private async keepAlive(): Promise<void> {
    while (this.isRunning && !this.processor.shuttingDown) {
      for (let elapsed = 0; elapsed < config.realtime.healthCheckIntervalMs; elapsed += 1000) {
        if (!this.isRunning || this.processor.shuttingDown) return;
        await sleep(1000);
      }

      if (!this.isRunning || this.processor.shuttingDown) return;

      try {
        await this.updateLagMetrics();
      } catch (err) {
        log.warn({ error: (err as Error).message }, 'Health check failed, reconnecting...');
        await this.reconnect();
      }
    }
  }

  private async reconnect(): Promise<void> {
    let attempt = 0;

    while (this.isRunning && !this.processor.shuttingDown) {
      attempt++;
      metrics.incrementCounter('solana_indexer_realtime_reconnect_total');
      metrics.setLifecycleState('realtime_gap_fill');
      log.info({ attempt }, 'Reconnecting realtime indexer...');
      await this.unsubscribe();
      await sleep(config.realtime.reconnectDelayMs);

      if (!this.isRunning) {
        return;
      }

      this.isGapFilling = true;

      try {
        await this.subscribe();
        await this.coldStart();
        await this.flushPendingSignatures('Processing transactions queued during reconnect');
        await this.updateLagMetrics();
        metrics.setLifecycleState('realtime_live');
        return;
      } catch (err) {
        await this.unsubscribe();
        log.warn(
          { attempt, error: (err as Error).message },
          'Reconnect attempt failed, retrying with preserved pending signatures',
        );
      }
    }
  }

  private async unsubscribe(): Promise<void> {
    if (this.subscriptionId !== null) {
      const connection = this.rpcClient.getConnection();
      try {
        await connection.removeOnLogsListener(this.subscriptionId);
        log.info({ subscriptionId: this.subscriptionId }, 'Unsubscribed from program logs');
      } catch (err) {
        log.warn({ error: (err as Error).message }, 'Error unsubscribing');
      }
      this.subscriptionId = null;
    }
  }

  async stop(): Promise<void> {
    log.info('Stopping realtime indexer');
    this.isRunning = false;
    metrics.setLifecycleState('stopping');
    this.processor.requestShutdown();
    await this.unsubscribe();
    await this.processor.waitForDrain();
    metrics.setLifecycleState('stopped');
    log.info('Realtime indexer stopped');
  }

  private async flushPendingSignatures(message: string): Promise<void> {
    if (this.pendingSignatures.length === 0) {
      return;
    }

    const uniqueSignatures = Array.from(new Set(this.pendingSignatures));
    metrics.setGauge('solana_indexer_realtime_queue_size', uniqueSignatures.length);
    log.info({ count: uniqueSignatures.length }, message);
    const stats = await this.processor.processBatch(uniqueSignatures);
    if (stats.aborted) {
      throw new Error(`Queued realtime batch aborted at signature ${stats.failedSignature ?? 'unknown'}`);
    }
    this.pendingSignatures = [];
    metrics.setGauge('solana_indexer_realtime_queue_size', 0);
  }

  private async updateLagMetrics(): Promise<void> {
    const currentSlot = await this.rpcClient.getConnection().getSlot();
    const lastProcessedSlot = await this.processor.getLastProcessedSlot();
    metrics.setGauge('solana_indexer_current_slot', currentSlot);

    if (lastProcessedSlot === null) {
      metrics.setGauge('solana_indexer_realtime_lag_slots', 0);
      return;
    }

    const lag = Math.max(0, currentSlot - lastProcessedSlot);
    metrics.setGauge('solana_indexer_last_processed_slot', lastProcessedSlot);
    metrics.setGauge('solana_indexer_realtime_lag_slots', lag);

    if (lag >= config.realtime.lagWarningSlots) {
      log.warn(
        { lagSlots: lag, currentSlot, lastProcessedSlot, threshold: config.realtime.lagWarningSlots },
        'Realtime indexer is lagging behind the cluster',
      );
    }
  }
}
