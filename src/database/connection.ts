import knex, { Knex } from 'knex';
import { config } from '../config';
import { createChildLogger } from '../utils/logger';

const log = createChildLogger('database');

let db: Knex | null = null;

export function getDb(): Knex {
  if (!db) {
    db = knex({
      client: 'pg',
      connection: config.database.url,
      pool: { min: 2, max: 10, acquireTimeoutMillis: 30000 },
    });
    log.info('Database connection pool created');
  }
  return db;
}

export async function testConnection(): Promise<void> {
  const database = getDb();
  try {
    await database.raw('SELECT 1');
    log.info('Database connection verified');
  } catch (err) {
    log.error({ error: (err as Error).message }, 'Database connection failed');
    throw err;
  }
}

export async function closeDb(): Promise<void> {
  if (db) {
    await db.destroy();
    db = null;
    log.info('Database connection closed');
  }
}
