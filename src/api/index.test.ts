import { AddressInfo } from 'net';

const mockQueryInstructions = jest.fn();
const mockCountInstructions = jest.fn();
const mockAggregateInstructions = jest.fn();
const mockQueryEvents = jest.fn();
const mockCountEvents = jest.fn();
const mockAggregateEvents = jest.fn();
const mockQueryAccountHistory = jest.fn();
const mockCountAccountHistory = jest.fn();
const mockGetProgramStats = jest.fn();
const mockGetIndexerState = jest.fn();
const mockRaw = jest.fn();
const mockQueryBuilder = {
  where: jest.fn().mockReturnThis(),
  clone: jest.fn().mockReturnThis(),
  orderBy: jest.fn().mockReturnThis(),
  limit: jest.fn().mockReturnThis(),
  offset: jest.fn().mockReturnThis(),
  count: jest.fn().mockReturnThis(),
  first: jest.fn().mockResolvedValue({ total: '0' }),
};
const mockDb = Object.assign(
  jest.fn(() => mockQueryBuilder),
  { raw: mockRaw },
);

jest.mock('../config', () => ({
  config: {
    api: {
      host: '127.0.0.1',
      port: 0,
      authToken: undefined,
      rateLimitWindowMs: 60000,
      rateLimitMaxRequests: 120,
      enableMetrics: true,
    },
    indexer: { mode: 'batch' },
    realtime: { lagWarningSlots: 150 },
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
  queryInstructions: (...args: unknown[]) => mockQueryInstructions(...args),
  countInstructions: (...args: unknown[]) => mockCountInstructions(...args),
  aggregateInstructions: (...args: unknown[]) => mockAggregateInstructions(...args),
  queryEvents: (...args: unknown[]) => mockQueryEvents(...args),
  countEvents: (...args: unknown[]) => mockCountEvents(...args),
  aggregateEvents: (...args: unknown[]) => mockAggregateEvents(...args),
  queryAccountHistory: (...args: unknown[]) => mockQueryAccountHistory(...args),
  countAccountHistory: (...args: unknown[]) => mockCountAccountHistory(...args),
  getProgramStats: (...args: unknown[]) => mockGetProgramStats(...args),
  getIndexerState: (...args: unknown[]) => mockGetIndexerState(...args),
}));

jest.mock('../database/connection', () => ({
  getDb: jest.fn(() => mockDb),
}));

import { createApi } from './index';
import { config } from '../config';
import { metrics } from '../observability/metrics';

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
  events: [
    {
      name: 'DepositEvent',
      fields: [{ name: 'amount', type: 'u64' }],
    },
  ],
  types: [],
} as any;

async function withServer<T>(fn: (baseUrl: string) => Promise<T>): Promise<T> {
  const app = createApi(idl);
  const server = await new Promise<ReturnType<typeof app.listen>>((resolve) => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
  });

  try {
    const { port } = server.address() as AddressInfo;
    return await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  }
}

describe('API validation', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    metrics.setLifecycleState('api_ready');
    (config as any).api.authToken = undefined;
    (config as any).api.rateLimitWindowMs = 60000;
    (config as any).api.rateLimitMaxRequests = 120;
    (config as any).api.enableMetrics = true;
    mockRaw.mockResolvedValue(undefined);
    mockGetProgramStats.mockResolvedValue({});
    mockGetIndexerState.mockResolvedValue(null);
    mockQueryInstructions.mockResolvedValue([]);
    mockCountInstructions.mockResolvedValue(0);
    mockAggregateInstructions.mockResolvedValue([]);
    mockQueryEvents.mockResolvedValue([]);
    mockCountEvents.mockResolvedValue(0);
    mockAggregateEvents.mockResolvedValue([]);
    mockQueryAccountHistory.mockResolvedValue([]);
    mockCountAccountHistory.mockResolvedValue(0);
  });

  it('returns 400 for unknown instruction filter columns', async () => {
    await withServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/instructions/deposit?unknown=value`);
      const payload = await response.json() as { message: string };

      expect(response.status).toBe(400);
      expect(payload.message).toContain('Unknown instruction filter column');
      expect(mockQueryInstructions).not.toHaveBeenCalled();
    });
  });

  it('returns 401 when API auth is enabled and no token is provided', async () => {
    (config as any).api.authToken = 'secret-token';

    await withServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/stats`);
      const payload = await response.json() as { error: string };

      expect(response.status).toBe(401);
      expect(payload.error).toBe('Unauthorized');
    });
  });

  it('returns metrics when enabled and a valid API token is provided', async () => {
    (config as any).api.authToken = 'secret-token';

    await withServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/metrics`, {
        headers: { Authorization: 'Bearer secret-token' },
      });
      const payload = await response.text();

      expect(response.status).toBe(200);
      expect(payload).toContain('process_uptime_seconds');
    });
  });

  it('returns 429 when the rate limit is exceeded', async () => {
    (config as any).api.rateLimitMaxRequests = 1;
    (config as any).api.rateLimitWindowMs = 60000;

    await withServer(async (baseUrl) => {
      const firstResponse = await fetch(`${baseUrl}/api/stats`);
      const secondResponse = await fetch(`${baseUrl}/api/stats`);
      const payload = await secondResponse.json() as { error: string };

      expect(firstResponse.status).toBe(200);
      expect(secondResponse.status).toBe(429);
      expect(payload.error).toBe('Rate limit exceeded');
    });
  });

  it('serves a root landing page', async () => {
    await withServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/`);
      const payload = await response.text();

      expect(response.status).toBe(200);
      expect(payload).toContain('Solana Universal Indexer');
      expect(payload).toContain('Program Stats');
      expect(payload).toContain('Data Explorer');
      expect(payload).toContain('/api/stats');
      expect(payload).toContain('/health');
    });
  });

  it('returns 400 for invalid aggregation intervals', async () => {
    await withServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/instructions/deposit/aggregate?interval=minute`);
      const payload = await response.json() as { message: string };

      expect(response.status).toBe(400);
      expect(payload.message).toContain('Invalid interval');
      expect(mockAggregateInstructions).not.toHaveBeenCalled();
    });
  });

  it('returns readiness information', async () => {
    await withServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/ready`);
      const payload = await response.json() as { status: string };

      expect(response.status).toBe(200);
      expect(payload.status).toBe('ready');
    });
  });

  it('returns 400 for invalid transaction slot filters', async () => {
    await withServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/transactions?slot_from=abc`);
      const payload = await response.json() as { message: string };

      expect(response.status).toBe(400);
      expect(payload.message).toContain('Invalid slot_from');
    });
  });

  it('returns 400 for unknown event filter columns', async () => {
    await withServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/events/deposit_event?mystery=value`);
      const payload = await response.json() as { message: string };

      expect(response.status).toBe(400);
      expect(payload.message).toContain('Unknown event filter column');
      expect(mockQueryEvents).not.toHaveBeenCalled();
    });
  });

  it('returns 400 for unknown account filter columns', async () => {
    await withServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/accounts/vault?mystery=value`);
      const payload = await response.json() as { message: string };

      expect(response.status).toBe(400);
      expect(payload.message).toContain('Unknown account filter column');
    });
  });

  it('returns 400 for unknown account history filter columns', async () => {
    await withServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/accounts/vault/test-pubkey/history?mystery=value`);
      const payload = await response.json() as { message: string };

      expect(response.status).toBe(400);
      expect(payload.message).toContain('Unknown account history filter column');
      expect(mockQueryAccountHistory).not.toHaveBeenCalled();
    });
  });
});
