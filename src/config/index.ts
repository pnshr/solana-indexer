import { z } from 'zod';
import dotenv from 'dotenv';

dotenv.config();

// Solana base58 alphabet, 32–44 characters (32 bytes decoded).
const SOLANA_PUBKEY_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

const indexerModeSchema = z.enum(['realtime', 'batch', 'backfill_then_realtime']);

const configSchema = z.object({
  solana: z.object({
    rpcUrl: z.string().url(),
    wsUrl: z.string().refine(
      (v) => v.startsWith('ws://') || v.startsWith('wss://'),
      { message: 'SOLANA_WS_URL must start with ws:// or wss://' },
    ),
    programId: z.string().regex(
      SOLANA_PUBKEY_RE,
      'PROGRAM_ID must be a valid base58 Solana public key (32–44 characters)',
    ),
  }),
  idlPath: z.string(),
  database: z.object({
    url: z.string(),
  }),
  api: z.object({
    port: z.number().int().positive(),
    host: z.string(),
    authToken: z.string().min(1).optional(),
    rateLimitWindowMs: z.number().int().positive(),
    rateLimitMaxRequests: z.number().int().positive(),
    enableMetrics: z.boolean(),
  }),
  indexer: z.object({
    mode: indexerModeSchema,
    batchStartSlot: z.number().int().nonnegative().optional(),
    batchEndSlot: z.number().int().nonnegative().optional(),
    batchSignatures: z.array(z.string()).optional(),
    batchSize: z.number().int().positive(),
    batchResume: z.boolean(),
    disableRun: z.boolean(),
  }),
  realtime: z.object({
    healthCheckIntervalMs: z.number().int().positive(),
    reconnectDelayMs: z.number().int().positive(),
    lagWarningSlots: z.number().int().nonnegative(),
  }),
  retry: z.object({
    maxRetries: z.number().int().nonnegative(),
    initialDelayMs: z.number().int().positive(),
    maxDelayMs: z.number().int().positive(),
  }),
  logLevel: z.enum(['debug', 'info', 'warn', 'error']),
});

export type Config = z.infer<typeof configSchema>;

function parseSignatures(raw?: string): string[] | undefined {
  if (!raw || raw.trim() === '') return undefined;
  return raw.split(',').map((s) => s.trim()).filter(Boolean);
}

function parseOptionalInt(raw: string | undefined, field: string): number | undefined {
  if (!raw || raw.trim() === '') return undefined;
  const value = Number.parseInt(raw, 10);
  if (Number.isNaN(value)) {
    throw new Error(`Invalid ${field}: expected integer, received "${raw}"`);
  }
  return value;
}

function parseBoolean(raw: string | undefined, defaultValue: boolean): boolean {
  if (!raw || raw.trim() === '') return defaultValue;
  const normalized = raw.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  throw new Error(`Invalid boolean value: "${raw}"`);
}

function loadConfig(): Config {
  const raw = {
    solana: {
      rpcUrl: process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com',
      wsUrl: process.env.SOLANA_WS_URL || 'wss://api.mainnet-beta.solana.com',
      programId: process.env.PROGRAM_ID || '',
    },
    idlPath: process.env.IDL_PATH || './idl.json',
    database: {
      url: process.env.DATABASE_URL || 'postgresql://indexer:indexer@localhost:5432/solana_indexer',
    },
    api: {
      // PORT is set by preview/hosting environments; API_PORT is the project-specific override.
      port: Number.parseInt(process.env.PORT || process.env.API_PORT || '3000', 10),
      host: process.env.API_HOST || '0.0.0.0',
      authToken: process.env.API_AUTH_TOKEN?.trim() || undefined,
      rateLimitWindowMs: Number.parseInt(process.env.API_RATE_LIMIT_WINDOW_MS || '60000', 10),
      rateLimitMaxRequests: Number.parseInt(process.env.API_RATE_LIMIT_MAX_REQUESTS || '120', 10),
      enableMetrics: parseBoolean(process.env.ENABLE_METRICS, true),
    },
    indexer: {
      mode: (process.env.INDEXER_MODE as z.infer<typeof indexerModeSchema>) || 'realtime',
      batchStartSlot: parseOptionalInt(process.env.BATCH_START_SLOT, 'BATCH_START_SLOT'),
      batchEndSlot: parseOptionalInt(process.env.BATCH_END_SLOT, 'BATCH_END_SLOT'),
      batchSignatures: parseSignatures(process.env.BATCH_SIGNATURES),
      batchSize: Number.parseInt(process.env.BATCH_SIZE || '100', 10),
      batchResume: parseBoolean(process.env.BATCH_RESUME, true),
      disableRun: parseBoolean(process.env.INDEXER_DISABLE_RUN, false),
    },
    realtime: {
      healthCheckIntervalMs: Number.parseInt(process.env.REALTIME_HEALTHCHECK_INTERVAL_MS || '30000', 10),
      reconnectDelayMs: Number.parseInt(process.env.REALTIME_RECONNECT_DELAY_MS || '5000', 10),
      lagWarningSlots: Number.parseInt(process.env.REALTIME_LAG_WARNING_SLOTS || '150', 10),
    },
    retry: {
      maxRetries: Number.parseInt(process.env.MAX_RETRIES || '5', 10),
      initialDelayMs: Number.parseInt(process.env.INITIAL_RETRY_DELAY_MS || '500', 10),
      maxDelayMs: Number.parseInt(process.env.MAX_RETRY_DELAY_MS || '30000', 10),
    },
    logLevel: (process.env.LOG_LEVEL as 'debug' | 'info' | 'warn' | 'error') || 'info',
  };

  return configSchema.parse(raw);
}

export const config = loadConfig();
