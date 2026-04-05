import { BatchIndexer } from './batch';

const mockGetIndexerState = jest.fn();
const mockSetIndexerState = jest.fn();
const mockDeleteIndexerState = jest.fn();

jest.mock('../config', () => ({
  config: {
    indexer: {
      batchSignatures: undefined,
      batchStartSlot: 95,
      batchEndSlot: 110,
      batchResume: true,
    },
    logLevel: 'error',
  },
}));

jest.mock('../utils/logger', () => ({
  createChildLogger: jest.fn(() => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  })),
}));

jest.mock('../database/repository', () => ({
  getIndexerState: (...args: unknown[]) => mockGetIndexerState(...args),
  setIndexerState: (...args: unknown[]) => mockSetIndexerState(...args),
  deleteIndexerState: (...args: unknown[]) => mockDeleteIndexerState(...args),
}));

import { config } from '../config';

const mockConfig = config as typeof config & {
  indexer: {
    batchSignatures: string[] | undefined;
    batchStartSlot: number | undefined;
    batchEndSlot: number | undefined;
    batchResume: boolean;
  };
};

describe('BatchIndexer', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockConfig.indexer.batchSignatures = undefined;
    mockConfig.indexer.batchStartSlot = 95;
    mockConfig.indexer.batchEndSlot = 110;
    mockConfig.indexer.batchResume = true;
    mockGetIndexerState.mockResolvedValue(null);
    mockSetIndexerState.mockResolvedValue(undefined);
    mockDeleteIndexerState.mockResolvedValue(undefined);
  });

  it('stops paginating once it moves past batchStartSlot', async () => {
    const firstPage = Array.from({ length: 1000 }, (_, index) => ({
      signature: `sig-${1099 - index}`,
      slot: 1099 - index,
    }));

    const rpcClient = {
      getSignatures: jest
        .fn()
        .mockResolvedValueOnce(firstPage)
        .mockResolvedValueOnce([
          { signature: 'sig-90', slot: 90 },
          { signature: 'sig-80', slot: 80 },
        ]),
      getProgramId: jest.fn(() => ({ toBase58: () => '11111111111111111111111111111111' })),
    } as any;

    const processor = {
      processBatch: jest.fn().mockResolvedValue({ processed: 2, decoded: 2, errors: 0 }),
      indexProgramAccounts: jest.fn().mockResolvedValue(3),
    } as any;

    const indexer = new BatchIndexer(rpcClient, processor);
    await indexer.run();

    expect(rpcClient.getSignatures).toHaveBeenCalledTimes(2);
    const [signatures] = (processor.processBatch as jest.Mock).mock.calls[0];
    expect(signatures).toEqual([
      'sig-100',
      'sig-101',
      'sig-102',
      'sig-103',
      'sig-104',
      'sig-105',
      'sig-106',
      'sig-107',
      'sig-108',
      'sig-109',
      'sig-110',
    ]);
    expect(processor.indexProgramAccounts).toHaveBeenCalledTimes(1);
  });

  it('uses explicit signature mode without scanning history', async () => {
    mockConfig.indexer.batchSignatures = ['sig-1', 'sig-2'];

    const rpcClient = {
      getSignatures: jest.fn(),
      getProgramId: jest.fn(() => ({ toBase58: () => '11111111111111111111111111111111' })),
    } as any;

    const processor = {
      processBatch: jest.fn().mockResolvedValue({ processed: 2, decoded: 1, errors: 0 }),
      indexProgramAccounts: jest.fn(),
    } as any;

    const indexer = new BatchIndexer(rpcClient, processor);
    await indexer.run();

    const [signatures] = (processor.processBatch as jest.Mock).mock.calls[0];
    expect(signatures).toEqual(['sig-1', 'sig-2']);
    expect(rpcClient.getSignatures).not.toHaveBeenCalled();
    expect(processor.indexProgramAccounts).not.toHaveBeenCalled();
  });

  it('resumes a signature batch from the stored checkpoint when batch resume is enabled', async () => {
    mockConfig.indexer.batchSignatures = ['sig-1', 'sig-2', 'sig-3'];
    mockGetIndexerState
      .mockResolvedValueOnce('same-context')
      .mockResolvedValueOnce('sig-2');

    const rpcClient = {
      getSignatures: jest.fn(),
      getProgramId: jest.fn(() => ({ toBase58: () => '11111111111111111111111111111111' })),
    } as any;

    const processor = {
      processBatch: jest.fn(async (signatures: string[], options?: { onProcessedSignature?: (signature: string) => Promise<void> }) => {
        if (options?.onProcessedSignature) {
          for (const signature of signatures) {
            await options.onProcessedSignature(signature);
          }
        }
        return { processed: signatures.length, decoded: signatures.length, errors: 0, aborted: false, failedSignature: null };
      }),
      indexProgramAccounts: jest.fn(),
    } as any;

    const indexer = new BatchIndexer(rpcClient, processor);
    jest.spyOn(indexer as any, 'buildBatchContext').mockReturnValue('same-context');

    await indexer.run();

    const [signatures] = (processor.processBatch as jest.Mock).mock.calls[0];
    expect(signatures).toEqual(['sig-3']);
    expect(mockSetIndexerState).toHaveBeenCalled();
    expect(mockDeleteIndexerState).toHaveBeenCalled();
  });
});
