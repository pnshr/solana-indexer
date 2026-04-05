const mockGetParsedTransaction = jest.fn();
const mockGetParsedTransactions = jest.fn();

jest.mock('@solana/web3.js', () => {
  const actual = jest.requireActual('@solana/web3.js');
  return {
    ...actual,
    Connection: jest.fn().mockImplementation(() => ({
      getParsedTransaction: mockGetParsedTransaction,
      getParsedTransactions: mockGetParsedTransactions,
      getSignaturesForAddress: jest.fn(),
      getAccountInfo: jest.fn(),
      getMultipleAccountsInfo: jest.fn(),
      getProgramAccounts: jest.fn(),
      getSlot: jest.fn(),
    })),
  };
});

jest.mock('../config', () => ({
  config: {
    solana: {
      rpcUrl: 'https://rpc.example.com',
      wsUrl: 'wss://rpc.example.com',
      programId: '11111111111111111111111111111111',
    },
    retry: {
      maxRetries: 3,
      initialDelayMs: 1,
      maxDelayMs: 1,
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

jest.mock('../utils/retry', () => {
  const actual = jest.requireActual('../utils/retry');
  return {
    ...actual,
    sleep: jest.fn(async () => undefined),
  };
});

import { RpcClient } from './rpc-client';

describe('RpcClient', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('uses single-transaction RPC for one-signature chunks', async () => {
    const transaction = { slot: 1 } as any;
    mockGetParsedTransaction.mockResolvedValue(transaction);

    const client = new RpcClient();
    const result = await client.getTransactionBatch(['sig-1']);

    expect(result).toEqual([transaction]);
    expect(mockGetParsedTransaction).toHaveBeenCalledTimes(1);
    expect(mockGetParsedTransactions).not.toHaveBeenCalled();
  });

  it('disables batch RPC after a paid-plan batch error and falls back to individual requests', async () => {
    const paidPlanError = new Error(
      '403 Forbidden: {"jsonrpc":"2.0","error":{"code":-32403,"message":"Batch requests are only available for paid plans. Please upgrade if you would like to gain access"}}',
    );
    const transactions = [{ slot: 1 }, { slot: 2 }, { slot: 3 }, { slot: 4 }] as any[];

    mockGetParsedTransactions.mockRejectedValueOnce(paidPlanError);
    mockGetParsedTransaction
      .mockResolvedValueOnce(transactions[0])
      .mockResolvedValueOnce(transactions[1])
      .mockResolvedValueOnce(transactions[2])
      .mockResolvedValueOnce(transactions[3]);

    const client = new RpcClient();
    const result = await client.getTransactionBatch(['sig-1', 'sig-2', 'sig-3', 'sig-4'], 2);

    expect(result).toEqual(transactions);
    expect(mockGetParsedTransactions).toHaveBeenCalledTimes(1);
    expect(mockGetParsedTransaction).toHaveBeenCalledTimes(4);
  });

  it('falls back per chunk for generic batch failures but keeps batch RPC enabled for later chunks', async () => {
    const genericError = new Error('503 upstream timeout');
    const transactions = [{ slot: 1 }, { slot: 2 }, { slot: 3 }, { slot: 4 }] as any[];

    mockGetParsedTransactions
      .mockRejectedValueOnce(genericError)
      .mockRejectedValueOnce(genericError)
      .mockRejectedValueOnce(genericError)
      .mockRejectedValueOnce(genericError)
      .mockResolvedValueOnce([transactions[2], transactions[3]]);
    mockGetParsedTransaction
      .mockResolvedValueOnce(transactions[0])
      .mockResolvedValueOnce(transactions[1]);

    const client = new RpcClient();
    const result = await client.getTransactionBatch(['sig-1', 'sig-2', 'sig-3', 'sig-4'], 2);

    expect(result).toEqual(transactions);
    expect(mockGetParsedTransactions).toHaveBeenCalledTimes(5);
    expect(mockGetParsedTransaction).toHaveBeenCalledTimes(2);
  });
});
