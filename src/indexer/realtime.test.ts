import { PublicKey } from '@solana/web3.js';
import { RealtimeIndexer } from './realtime';

const PROGRAM_ID = '11111111111111111111111111111111';

jest.mock('../utils/logger', () => ({
  createChildLogger: jest.fn(() => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  })),
}));

jest.mock('../utils/retry', () => ({
  sleep: jest.fn(async () => undefined),
}));

describe('RealtimeIndexer', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('queues signatures that arrive during cold start and flushes them after gap fill', async () => {
    let onLogsCallback: ((logs: { signature: string }) => Promise<void>) | undefined;
    let resolveGapFill!: (signatures: Array<{ signature: string }>) => void;
    const gapFillPromise = new Promise<Array<{ signature: string }>>((resolve) => {
      resolveGapFill = resolve;
    });

    const connection = {
      onLogs: jest.fn((_programId, callback) => {
        onLogsCallback = callback;
        return 7;
      }),
      removeOnLogsListener: jest.fn(),
      getSlot: jest.fn().mockResolvedValue(123),
    };

    const rpcClient = {
      getConnection: jest.fn(() => connection),
      getProgramId: jest.fn(() => new PublicKey(PROGRAM_ID)),
      getAllSignaturesSince: jest.fn(() => gapFillPromise),
      getTransaction: jest.fn(),
    } as any;

    const processor = {
      getLastProcessedSignature: jest.fn().mockResolvedValue('sig-prev'),
      getLastProcessedSlot: jest.fn().mockResolvedValue(120),
      processBatch: jest.fn().mockResolvedValue({ processed: 1, decoded: 1, errors: 0 }),
      processTransaction: jest.fn(),
      indexProgramAccounts: jest.fn().mockResolvedValue(0),
      requestShutdown: jest.fn(),
      waitForDrain: jest.fn().mockResolvedValue(undefined),
      shuttingDown: false,
    } as any;

    const indexer = new RealtimeIndexer(rpcClient, processor);
    jest.spyOn(indexer as any, 'keepAlive').mockResolvedValue(undefined);

    const startPromise = indexer.start();
    await Promise.resolve();
    await Promise.resolve();

    expect(connection.onLogs).toHaveBeenCalledTimes(1);
    expect(onLogsCallback).toBeDefined();

    await onLogsCallback!({ signature: 'sig-live' });
    await onLogsCallback!({ signature: 'sig-live' });

    resolveGapFill([{ signature: 'sig-gap' }]);
    await startPromise;

    expect(processor.processBatch).toHaveBeenNthCalledWith(1, ['sig-gap']);
    expect(processor.processBatch).toHaveBeenNthCalledWith(2, ['sig-live']);
    expect(processor.processTransaction).not.toHaveBeenCalled();
    expect(rpcClient.getTransaction).not.toHaveBeenCalled();
    expect(processor.indexProgramAccounts).toHaveBeenCalledTimes(1);
  });

  it('marks gap-fill active before subscribe completes so early websocket events are queued', async () => {
    const processor = {
      getLastProcessedSignature: jest.fn().mockResolvedValue(null),
      getLastProcessedSlot: jest.fn().mockResolvedValue(321),
      processBatch: jest.fn().mockResolvedValue({ processed: 0, decoded: 0, errors: 0 }),
      processTransaction: jest.fn(),
      indexProgramAccounts: jest.fn().mockResolvedValue(0),
      requestShutdown: jest.fn(),
      waitForDrain: jest.fn().mockResolvedValue(undefined),
      shuttingDown: false,
    } as any;

    const rpcClient = {
      getConnection: jest.fn(() => ({
        onLogs: jest.fn((_programId, callback) => {
          void callback({ signature: 'sig-early' });
          return 11;
        }),
        removeOnLogsListener: jest.fn(),
        getSlot: jest.fn().mockResolvedValue(321),
      })),
      getProgramId: jest.fn(() => new PublicKey(PROGRAM_ID)),
      getAllSignaturesSince: jest.fn().mockResolvedValue([]),
      getTransaction: jest.fn(),
    } as any;

    const indexer = new RealtimeIndexer(rpcClient, processor);
    jest.spyOn(indexer as any, 'keepAlive').mockResolvedValue(undefined);

    await indexer.start();

    expect(processor.processBatch).toHaveBeenCalledWith(['sig-early']);
    expect(processor.processTransaction).not.toHaveBeenCalled();
    expect(rpcClient.getTransaction).not.toHaveBeenCalled();
  });

  it('fails startup and preserves queued signatures when cold start fails', async () => {
    let onLogsCallback: ((logs: { signature: string }) => Promise<void>) | undefined;
    let rejectGapFill!: (error: Error) => void;
    const gapFillPromise = new Promise<Array<{ signature: string }>>((_resolve, reject) => {
      rejectGapFill = reject;
    });

    const connection = {
      onLogs: jest.fn((_programId, callback) => {
        onLogsCallback = callback;
        return 13;
      }),
      removeOnLogsListener: jest.fn(),
      getSlot: jest.fn().mockResolvedValue(456),
    };

    const processor = {
      getLastProcessedSignature: jest.fn().mockResolvedValue('sig-prev'),
      getLastProcessedSlot: jest.fn().mockResolvedValue(400),
      processBatch: jest.fn(),
      processTransaction: jest.fn(),
      indexProgramAccounts: jest.fn().mockResolvedValue(0),
      requestShutdown: jest.fn(),
      waitForDrain: jest.fn().mockResolvedValue(undefined),
      shuttingDown: false,
    } as any;

    const rpcClient = {
      getConnection: jest.fn(() => connection),
      getProgramId: jest.fn(() => new PublicKey(PROGRAM_ID)),
      getAllSignaturesSince: jest.fn(() => gapFillPromise),
      getTransaction: jest.fn(),
    } as any;

    const indexer = new RealtimeIndexer(rpcClient, processor);
    jest.spyOn(indexer as any, 'keepAlive').mockResolvedValue(undefined);

    const startPromise = indexer.start();
    await Promise.resolve();
    await Promise.resolve();

    await onLogsCallback!({ signature: 'sig-live' });
    rejectGapFill(new Error('rpc unavailable'));

    await expect(startPromise).rejects.toThrow('rpc unavailable');
    expect((indexer as any).pendingSignatures).toEqual(['sig-live']);
    expect(processor.indexProgramAccounts).not.toHaveBeenCalled();
  });
});
