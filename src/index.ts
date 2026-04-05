import { config } from './config';
import { createChildLogger, logger } from './utils/logger';
import { loadIdl } from './idl/parser';
import { getDb, testConnection, closeDb } from './database/connection';
import { generateSchema } from './database/schema';
import { RpcClient } from './indexer/rpc-client';
import { TransactionProcessor } from './indexer/processor';
import { BatchIndexer } from './indexer/batch';
import { RealtimeIndexer } from './indexer/realtime';
import { createApi, startApi } from './api';
import { metrics } from './observability/metrics';

const log = createChildLogger('main');

async function main(): Promise<void> {
  metrics.setLifecycleState('starting');
  log.info({ mode: config.indexer.mode }, 'Solana Universal Indexer starting');

  const idl = loadIdl(config.idlPath);

  await testConnection();
  const db = getDb();
  await generateSchema(db, idl, config.solana.programId);

  const rpcClient = new RpcClient();
  const processor = new TransactionProcessor(idl, rpcClient);
  const api = createApi(idl);
  const server = await startApi(api);
  metrics.setLifecycleState('api_ready');

  let isShuttingDown = false;
  let realtimeIndexer: RealtimeIndexer | null = null;

  async function shutdown(signal: string): Promise<void> {
    if (isShuttingDown) {
      log.warn('Force shutdown requested');
      process.exit(1);
    }

    isShuttingDown = true;
    metrics.setLifecycleState('stopping');
    log.info({ signal }, 'Graceful shutdown initiated');

    try {
      if (realtimeIndexer) {
        await realtimeIndexer.stop();
      } else {
        processor.requestShutdown();
        await processor.waitForDrain();
      }

      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
      log.info('API server closed');

      await closeDb();

      metrics.setLifecycleState('stopped');
      log.info('Shutdown complete');
      logger.flush();
      process.exit(0);
    } catch (err) {
      metrics.setLifecycleState('error');
      log.error({ error: (err as Error).message }, 'Error during shutdown');
      process.exit(1);
    }
  }

  function requestShutdown(signal: string): void {
    shutdown(signal).catch((err) => {
      log.error({ error: (err as Error).message, signal }, 'Unhandled shutdown error');
      process.exit(1);
    });
  }

  process.on('SIGINT', () => {
    requestShutdown('SIGINT');
  });
  process.on('SIGTERM', () => {
    requestShutdown('SIGTERM');
  });

  if (config.indexer.mode === 'batch') {
    metrics.setLifecycleState('batch_running');
    const batchIndexer = new BatchIndexer(rpcClient, processor);
    await batchIndexer.run();
    log.info('Batch indexing complete. API remains running.');
    return;
  }

  if (config.indexer.mode === 'backfill_then_realtime') {
    metrics.setLifecycleState('batch_running');
    const batchIndexer = new BatchIndexer(rpcClient, processor);
    await batchIndexer.run();
    log.info('Backfill phase complete, switching to realtime mode');
  }

  realtimeIndexer = new RealtimeIndexer(rpcClient, processor);
  realtimeIndexer.start().catch((err) => {
    metrics.setLifecycleState('error');
    log.error({ error: (err as Error).message }, 'Realtime indexer fatal error');
    requestShutdown('ERROR');
  });
}

main().catch((err) => {
  metrics.setLifecycleState('error');
  log.error({ error: (err as Error).message, stack: err.stack }, 'Fatal startup error');
  process.exit(1);
});
