import { PublicKey } from '@solana/web3.js';
import { TransactionProcessor } from './processor';
import { RpcClient } from './rpc-client';
import { TransactionDecoder } from '../decoder';
import {
  saveTransaction,
  saveInstruction,
  saveEvent,
  saveAccountState,
  setIndexerState,
  getIndexerState,
} from '../database/repository';
import { getDb } from '../database/connection';

const PROGRAM_ID = '11111111111111111111111111111111';
const TOUCHED_ACCOUNT = 'SysvarRent111111111111111111111111111111111';
const mockTransactionExecutor = { kind: 'trx' };
const mockTransaction = jest.fn();

jest.mock('../config', () => ({
  config: {
    solana: { programId: '11111111111111111111111111111111' },
    indexer: { batchSize: 2 },
    logLevel: 'info',
  },
}));

jest.mock('../utils/logger', () => ({
  logger: { flush: jest.fn() },
  createChildLogger: jest.fn(() => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  })),
}));

jest.mock('../database/connection', () => ({
  getDb: jest.fn(() => ({
    transaction: mockTransaction,
  })),
}));

jest.mock('../database/repository', () => ({
  saveTransaction: jest.fn(),
  saveInstruction: jest.fn(),
  saveEvent: jest.fn(),
  saveAccountState: jest.fn(),
  setIndexerState: jest.fn(),
  getIndexerState: jest.fn(),
}));

jest.mock('../decoder', () => ({
  TransactionDecoder: jest.fn(),
}));

function createTx(success = true): any {
  return {
    slot: 42,
    blockTime: 1_710_000_000,
    meta: { err: success ? null : { custom: 1 } },
    transaction: {
      message: {
        accountKeys: [
          { pubkey: new PublicKey(TOUCHED_ACCOUNT) },
          { pubkey: new PublicKey(PROGRAM_ID) },
        ],
      },
    },
  };
}

describe('TransactionProcessor', () => {
  const idl = {
    version: '0.1.0',
    name: 'test_program',
    instructions: [
      {
        name: 'deposit',
        accounts: [{ name: 'user', isMut: true, isSigner: true }],
        args: [{ name: 'amount', type: 'u64' }],
      },
    ],
    accounts: [
      {
        name: 'Vault',
        type: {
          kind: 'struct',
          fields: [{ name: 'authority', type: 'publicKey' }],
        },
      },
    ],
  } as any;

  const mockDecoder = {
    decodeTransaction: jest.fn(),
    decodeEvents: jest.fn(),
    decodeAccountAuto: jest.fn(),
  };

  const mockRpcClient = {
    getProgramId: jest.fn(() => new PublicKey(PROGRAM_ID)),
    getMultipleAccountsInfo: jest.fn(),
    getCurrentSlot: jest.fn(),
    getProgramAccounts: jest.fn(),
    getTransactionBatch: jest.fn(),
  } as unknown as RpcClient;

  beforeEach(() => {
    jest.clearAllMocks();
    mockTransaction.mockImplementation(async (callback: (trx: unknown) => Promise<unknown>) => callback(mockTransactionExecutor));
    (TransactionDecoder as jest.Mock).mockImplementation(() => mockDecoder);
    mockDecoder.decodeTransaction.mockReturnValue([
      {
        name: 'deposit',
        args: { amount: '10' },
        accounts: { user: TOUCHED_ACCOUNT },
        instructionIndex: 0,
      },
    ]);
    mockDecoder.decodeEvents.mockReturnValue([
      {
        name: 'DepositEvent',
        data: { amount: '10' },
        eventIndex: 0,
      },
    ]);
    mockDecoder.decodeAccountAuto.mockReturnValue({
      pubkey: TOUCHED_ACCOUNT,
      name: 'Vault',
      data: { authority: TOUCHED_ACCOUNT },
      owner: PROGRAM_ID,
      lamports: 10,
      slot: 42,
    });
    (saveTransaction as jest.Mock).mockResolvedValue(true);
    (saveInstruction as jest.Mock).mockResolvedValue(undefined);
    (saveEvent as jest.Mock).mockResolvedValue(undefined);
    (saveAccountState as jest.Mock).mockResolvedValue(undefined);
    (setIndexerState as jest.Mock).mockResolvedValue(undefined);
    (getIndexerState as jest.Mock).mockResolvedValue(null);
    (getDb as jest.Mock).mockReturnValue({ transaction: mockTransaction });
    (mockRpcClient.getMultipleAccountsInfo as jest.Mock).mockResolvedValue([
      {
        executable: false,
        owner: new PublicKey(PROGRAM_ID),
        data: Buffer.from([1, 2, 3]),
        lamports: 10,
      },
    ]);
  });

  it('writes transaction data inside a single DB transaction and refreshes account state', async () => {
    const processor = new TransactionProcessor(idl, mockRpcClient);

    const decodedCount = await processor.processTransaction(createTx(), 'sig-1');

    expect(decodedCount).toBe(2);
    expect(mockTransaction).toHaveBeenCalledTimes(1);
    expect(saveTransaction).toHaveBeenCalledWith(
      expect.objectContaining({ signature: 'sig-1', slot: 42, success: true }),
      mockTransactionExecutor,
    );
    expect(saveInstruction).toHaveBeenCalledWith(
      idl,
      'deposit',
      'sig-1',
      42,
      expect.any(Date),
      0,
      { amount: '10' },
      { user: TOUCHED_ACCOUNT },
      mockTransactionExecutor,
    );
    expect(saveEvent).toHaveBeenCalledWith(
      idl,
      'DepositEvent',
      'sig-1',
      42,
      expect.any(Date),
      0,
      { amount: '10' },
      mockTransactionExecutor,
    );
    expect(setIndexerState).toHaveBeenNthCalledWith(1, 'last_processed_signature', 'sig-1', mockTransactionExecutor);
    expect(setIndexerState).toHaveBeenNthCalledWith(2, 'last_processed_slot', '42', mockTransactionExecutor);
    expect(mockRpcClient.getMultipleAccountsInfo).toHaveBeenCalledWith([new PublicKey(TOUCHED_ACCOUNT)]);
    expect(saveAccountState).toHaveBeenCalledWith(
      idl,
      expect.objectContaining({
        pubkey: TOUCHED_ACCOUNT,
        name: 'Vault',
        slot: 42,
        signature: 'sig-1',
        sourceKind: 'transaction',
        sourceRef: 'transaction:sig-1',
      }),
    );
  });

  it('skips instruction and state writes when another worker already claimed the transaction', async () => {
    (saveTransaction as jest.Mock).mockResolvedValue(false);
    const processor = new TransactionProcessor(idl, mockRpcClient);

    const decodedCount = await processor.processTransaction(createTx(), 'sig-2');

    expect(decodedCount).toBe(0);
    expect(saveInstruction).not.toHaveBeenCalled();
    expect(saveEvent).not.toHaveBeenCalled();
    expect(setIndexerState).not.toHaveBeenCalled();
    expect(saveAccountState).not.toHaveBeenCalled();
    expect(mockRpcClient.getMultipleAccountsInfo).not.toHaveBeenCalled();
  });

  it('aborts batch processing on a failed chunk to avoid skipping checkpoints', async () => {
    (mockRpcClient.getTransactionBatch as jest.Mock)
      .mockRejectedValueOnce(new Error('rpc unavailable'))
      .mockResolvedValueOnce([createTx(), createTx()]);

    const processor = new TransactionProcessor(idl, mockRpcClient);
    const stats = await processor.processBatch(['sig-1', 'sig-2', 'sig-3', 'sig-4']);

    expect(stats).toEqual({
      processed: 0,
      decoded: 0,
      errors: 1,
      aborted: true,
      failedSignature: 'sig-1',
    });
    expect(mockRpcClient.getTransactionBatch).toHaveBeenCalledTimes(1);
  });
});
