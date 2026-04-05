describe('config', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.resetModules();
    process.env = {
      ...originalEnv,
      SOLANA_RPC_URL: 'https://api.mainnet-beta.solana.com',
      SOLANA_WS_URL: 'wss://api.mainnet-beta.solana.com',
      PROGRAM_ID: '11111111111111111111111111111111',
      DATABASE_URL: 'postgresql://indexer:indexer@localhost:5432/solana_indexer',
    };
    delete process.env.BATCH_START_SLOT;
    delete process.env.BATCH_END_SLOT;
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it('throws when BATCH_START_SLOT is not an integer', () => {
    process.env.BATCH_START_SLOT = 'abc';

    expect(() => {
      jest.isolateModules(() => {
        require('./index');
      });
    }).toThrow('Invalid BATCH_START_SLOT');
  });

  it('throws when BATCH_END_SLOT is not an integer', () => {
    process.env.BATCH_END_SLOT = 'def';

    expect(() => {
      jest.isolateModules(() => {
        require('./index');
      });
    }).toThrow('Invalid BATCH_END_SLOT');
  });

  it('parses INDEXER_DISABLE_RUN as a boolean flag', () => {
    process.env.INDEXER_DISABLE_RUN = 'true';

    jest.isolateModules(() => {
      const { config } = require('./index');
      expect(config.indexer.disableRun).toBe(true);
    });
  });
});
