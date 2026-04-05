const mockLoadIdl = jest.fn();
const mockTestConnection = jest.fn();
const mockGetDb = jest.fn();
const mockCloseDb = jest.fn();
const mockGenerateSchema = jest.fn();
const mockCreateApi = jest.fn();
const mockStartApi = jest.fn();
const mockSetLifecycleState = jest.fn();
const mockBatchRun = jest.fn();
const mockRealtimeStart = jest.fn();

jest.mock('./config', () => ({
  config: {
    idlPath: './test-idl.json',
    solana: { programId: '11111111111111111111111111111111' },
    indexer: {
      mode: 'batch',
      disableRun: true,
    },
    logLevel: 'error',
  },
}));

jest.mock('./utils/logger', () => ({
  logger: { flush: jest.fn() },
  createChildLogger: jest.fn(() => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  })),
}));

jest.mock('./idl/parser', () => ({
  loadIdl: (...args: unknown[]) => mockLoadIdl(...args),
}));

jest.mock('./database/connection', () => ({
  getDb: (...args: unknown[]) => mockGetDb(...args),
  testConnection: (...args: unknown[]) => mockTestConnection(...args),
  closeDb: (...args: unknown[]) => mockCloseDb(...args),
}));

jest.mock('./database/schema', () => ({
  generateSchema: (...args: unknown[]) => mockGenerateSchema(...args),
}));

jest.mock('./indexer/rpc-client', () => ({
  RpcClient: jest.fn(() => ({ kind: 'rpc-client' })),
}));

jest.mock('./indexer/processor', () => ({
  TransactionProcessor: jest.fn(() => ({ kind: 'processor' })),
}));

jest.mock('./indexer/batch', () => ({
  BatchIndexer: jest.fn(() => ({
    run: (...args: unknown[]) => mockBatchRun(...args),
  })),
}));

jest.mock('./indexer/realtime', () => ({
  RealtimeIndexer: jest.fn(() => ({
    start: (...args: unknown[]) => mockRealtimeStart(...args),
  })),
}));

jest.mock('./api', () => ({
  createApi: (...args: unknown[]) => mockCreateApi(...args),
  startApi: (...args: unknown[]) => mockStartApi(...args),
}));

jest.mock('./observability/metrics', () => ({
  metrics: {
    setLifecycleState: (...args: unknown[]) => mockSetLifecycleState(...args),
  },
}));

describe('main bootstrap', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockLoadIdl.mockReturnValue({ name: 'test_program', version: '0.1.0', instructions: [] });
    mockTestConnection.mockResolvedValue(undefined);
    mockGetDb.mockReturnValue({ kind: 'db' });
    mockGenerateSchema.mockResolvedValue(undefined);
    mockCreateApi.mockReturnValue({ kind: 'api' });
    mockStartApi.mockResolvedValue({
      close: jest.fn((callback: (err?: Error | null) => void) => callback(null)),
    });
    mockBatchRun.mockResolvedValue(undefined);
    mockRealtimeStart.mockResolvedValue(undefined);
  });

  it('boots schema and API without starting indexers when INDEXER_DISABLE_RUN=true', async () => {
    const { main } = require('./index');
    const { BatchIndexer } = require('./indexer/batch');
    const { RealtimeIndexer } = require('./indexer/realtime');

    await main();

    expect(mockLoadIdl).toHaveBeenCalledWith('./test-idl.json');
    expect(mockTestConnection).toHaveBeenCalledTimes(1);
    expect(mockGenerateSchema).toHaveBeenCalledWith(
      { kind: 'db' },
      { name: 'test_program', version: '0.1.0', instructions: [] },
      '11111111111111111111111111111111',
    );
    expect(mockCreateApi).toHaveBeenCalledTimes(1);
    expect(mockStartApi).toHaveBeenCalledTimes(1);
    expect(BatchIndexer).not.toHaveBeenCalled();
    expect(RealtimeIndexer).not.toHaveBeenCalled();
    expect(mockBatchRun).not.toHaveBeenCalled();
    expect(mockRealtimeStart).not.toHaveBeenCalled();
    expect(mockSetLifecycleState).toHaveBeenCalledWith('api_ready');
  });
});
