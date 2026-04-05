import { getDb } from './connection';
import {
  getInstructionTableName,
  getAccountTableName,
  getAccountHistoryTableName,
  getEventTableName,
} from './schema';
import { AnchorIdl } from '../idl/types';
import { sanitizeSqlName } from '../idl/parser';
import { createChildLogger } from '../utils/logger';
import { Knex } from 'knex';

const log = createChildLogger('repository');
export type DbExecutor = Knex | Knex.Transaction;

export interface TransactionRecord {
  signature: string;
  slot: number;
  block_time: Date | null;
  success: boolean;
  err: string | null;
}

export interface DecodedInstruction {
  name: string;
  args: Record<string, any>;
  accounts: Record<string, string>;
  instructionIndex: number;
}

export interface DecodedEvent {
  name: string;
  data: Record<string, any>;
  eventIndex: number;
}

export interface DecodedAccount {
  pubkey: string;
  name: string;
  data: Record<string, any>;
  owner: string;
  lamports: number;
  slot: number;
  signature?: string | null;
  sourceKind?: 'transaction' | 'snapshot';
  sourceRef?: string;
}

type QueryFilters = Record<string, any>;

function applyFilters(
  query: Knex.QueryBuilder<any, any>,
  filters: QueryFilters,
): Knex.QueryBuilder<any, any> {
  let nextQuery = query;

  for (const [key, value] of Object.entries(filters)) {
    const colName = sanitizeSqlName(key);

    if (value === null) {
      nextQuery = nextQuery.whereNull(colName);
      continue;
    }

    if (typeof value === 'object' && value !== null && ('from' in value || 'to' in value)) {
      if (value.from !== undefined && value.from !== null && value.from !== '') {
        nextQuery = nextQuery.where(colName, '>=', value.from);
      }
      if (value.to !== undefined && value.to !== null && value.to !== '') {
        nextQuery = nextQuery.where(colName, '<=', value.to);
      }
      continue;
    }

    nextQuery = nextQuery.where(colName, value);
  }

  return nextQuery;
}

export async function saveTransaction(tx: TransactionRecord, executor?: DbExecutor): Promise<boolean> {
  const db = getDb();
  const runner = executor ?? db;
  const inserted = await runner('_transactions')
    .insert(tx)
    .onConflict('signature')
    .ignore()
    .returning('signature');

  return inserted.length > 0;
}

export async function saveTransactionBatch(txs: TransactionRecord[]): Promise<void> {
  if (txs.length === 0) return;
  const db = getDb();
  await db.transaction(async (trx) => {
    const chunkSize = 500;
    for (let i = 0; i < txs.length; i += chunkSize) {
      const chunk = txs.slice(i, i + chunkSize);
      await trx('_transactions').insert(chunk).onConflict('signature').ignore();
    }
  });
  log.debug({ count: txs.length }, 'Saved transaction batch');
}

export async function saveInstruction(
  idl: AnchorIdl,
  ixName: string,
  signature: string,
  slot: number,
  blockTime: Date | null,
  instructionIndex: number,
  args: Record<string, any>,
  accounts: Record<string, string>,
  executor?: DbExecutor,
): Promise<void> {
  const db = getDb();
  const runner = executor ?? db;
  const tableName = getInstructionTableName(idl, ixName);

  const row: Record<string, any> = {
    signature,
    slot,
    block_time: blockTime,
    instruction_index: instructionIndex,
  };

  for (const [name, pubkey] of Object.entries(accounts)) {
    row[sanitizeSqlName(`acc_${name}`)] = pubkey;
  }

  for (const [name, value] of Object.entries(args)) {
    const colName = sanitizeSqlName(name);
    if (typeof value === 'object' && value !== null) {
      row[colName] = JSON.stringify(value);
    } else if (typeof value === 'bigint') {
      row[colName] = value.toString();
    } else {
      row[colName] = value;
    }
  }

  await runner(tableName).insert(row);
  log.debug({ table: tableName, signature: signature.slice(0, 16) }, 'Saved instruction');
}

export async function saveEvent(
  idl: AnchorIdl,
  eventName: string,
  signature: string,
  slot: number,
  blockTime: Date | null,
  eventIndex: number,
  data: Record<string, any>,
  executor?: DbExecutor,
): Promise<void> {
  const db = getDb();
  const runner = executor ?? db;
  const tableName = getEventTableName(idl, eventName);

  const row: Record<string, any> = {
    signature,
    slot,
    block_time: blockTime,
    event_index: eventIndex,
  };

  for (const [name, value] of Object.entries(data)) {
    const colName = sanitizeSqlName(name);
    if (typeof value === 'object' && value !== null) {
      row[colName] = JSON.stringify(value);
    } else if (typeof value === 'bigint') {
      row[colName] = value.toString();
    } else {
      row[colName] = value;
    }
  }

  await runner(tableName).insert(row);
  log.debug({ table: tableName, signature: signature.slice(0, 16) }, 'Saved event');
}

export async function saveAccountState(idl: AnchorIdl, account: DecodedAccount, executor?: DbExecutor): Promise<void> {
  const db = getDb();
  const runner = executor ?? db;
  const tableName = getAccountTableName(idl, account.name);
  const historyTableName = getAccountHistoryTableName(idl, account.name);

  const row: Record<string, any> = {
    pubkey: account.pubkey,
    slot: account.slot,
    owner: account.owner,
    lamports: account.lamports,
    last_updated: db.fn.now(),
  };

  for (const [name, value] of Object.entries(account.data)) {
    const colName = sanitizeSqlName(name);
    if (typeof value === 'object' && value !== null) {
      row[colName] = JSON.stringify(value);
    } else if (typeof value === 'bigint') {
      row[colName] = value.toString();
    } else {
      row[colName] = value;
    }
  }

  const historyRow: Record<string, any> = {
    ...row,
    source_kind: account.sourceKind ?? (account.signature ? 'transaction' : 'snapshot'),
    source_ref: account.sourceRef ?? (account.signature ? `transaction:${account.signature}` : `snapshot:${account.slot}`),
    signature: account.signature ?? null,
    captured_at: db.fn.now(),
  };
  const { pubkey: _ignoredPubkey, ...latestStateUpdates } = row;
  delete historyRow.last_updated;

  await runner(tableName).insert(row).onConflict('pubkey').merge(latestStateUpdates);
  await runner(historyTableName)
    .insert(historyRow)
    .onConflict(['pubkey', 'source_ref'])
    .ignore();
  log.debug({ table: tableName, pubkey: account.pubkey }, 'Saved account state');
}

export async function getIndexerState(key: string): Promise<string | null> {
  const db = getDb();
  const row = await db('_indexer_state').where({ key }).first();
  return row?.value ?? null;
}

export async function setIndexerState(key: string, value: string, executor?: DbExecutor): Promise<void> {
  const db = getDb();
  const runner = executor ?? db;
  await runner('_indexer_state')
    .insert({ key, value, updated_at: db.fn.now() })
    .onConflict('key')
    .merge({ value, updated_at: db.fn.now() });
}

export async function deleteIndexerState(key: string, executor?: DbExecutor): Promise<void> {
  const db = getDb();
  const runner = executor ?? db;
  await runner('_indexer_state').where({ key }).del();
}

export async function isTransactionIndexed(signature: string): Promise<boolean> {
  const db = getDb();
  const row = await db('_transactions').where({ signature }).first();
  return !!row;
}

export async function queryInstructions(
  idl: AnchorIdl,
  ixName: string,
  filters: QueryFilters = {},
  options: { limit?: number; offset?: number; orderBy?: string; order?: 'asc' | 'desc' } = {},
): Promise<any[]> {
  const db = getDb();
  const tableName = getInstructionTableName(idl, ixName);
  let query: Knex.QueryBuilder<any, any> = applyFilters(db(tableName), filters);

  const orderBy = options.orderBy ? sanitizeSqlName(options.orderBy) : 'id';
  query = query.orderBy(orderBy, options.order || 'desc');
  if (options.limit !== undefined) query = query.limit(options.limit);
  if (options.offset !== undefined) query = query.offset(options.offset);

  return await query;
}

export async function queryEvents(
  idl: AnchorIdl,
  eventName: string,
  filters: QueryFilters = {},
  options: { limit?: number; offset?: number; orderBy?: string; order?: 'asc' | 'desc' } = {},
): Promise<any[]> {
  const db = getDb();
  const tableName = getEventTableName(idl, eventName);
  let query: Knex.QueryBuilder<any, any> = applyFilters(db(tableName), filters);

  const orderBy = options.orderBy ? sanitizeSqlName(options.orderBy) : 'id';
  query = query.orderBy(orderBy, options.order || 'desc');
  if (options.limit !== undefined) query = query.limit(options.limit);
  if (options.offset !== undefined) query = query.offset(options.offset);

  return await query;
}

export async function countInstructions(
  idl: AnchorIdl,
  ixName: string,
  filters: QueryFilters = {},
): Promise<number> {
  const db = getDb();
  const tableName = getInstructionTableName(idl, ixName);
  const result = await applyFilters(db(tableName), filters).count('* as total').first();
  return Number.parseInt(String(result?.total ?? 0), 10);
}

export async function countEvents(
  idl: AnchorIdl,
  eventName: string,
  filters: QueryFilters = {},
): Promise<number> {
  const db = getDb();
  const tableName = getEventTableName(idl, eventName);
  const result = await applyFilters(db(tableName), filters).count('* as total').first();
  return Number.parseInt(String(result?.total ?? 0), 10);
}

export async function aggregateInstructions(
  idl: AnchorIdl,
  ixName: string,
  options: {
    groupBy?: string;
    from?: Date;
    to?: Date;
    interval?: 'hour' | 'day' | 'week' | 'month';
  } = {},
): Promise<any[]> {
  const db = getDb();
  const tableName = getInstructionTableName(idl, ixName);
  let query: Knex.QueryBuilder<any, any> = db(tableName);
  const allowedIntervals = new Set(['hour', 'day', 'week', 'month']);

  if (options.from) query = query.where('block_time', '>=', options.from);
  if (options.to) query = query.where('block_time', '<=', options.to);

  if (options.interval) {
    if (!allowedIntervals.has(options.interval)) {
      throw new Error(`Invalid interval: ${options.interval}`);
    }

    const expr = `date_trunc('${options.interval}', block_time)`;
    query = query
      .select(db.raw(`${expr} as period`))
      .count('* as count')
      .groupByRaw(expr)
      .orderByRaw(`${expr} ASC`);
  } else if (options.groupBy) {
    const col = sanitizeSqlName(options.groupBy);
    query = query.select(col).count('* as count').groupBy(col).orderBy('count', 'desc');
  } else {
    query = query.count('* as count');
  }

  return await query;
}

export async function aggregateEvents(
  idl: AnchorIdl,
  eventName: string,
  options: {
    groupBy?: string;
    from?: Date;
    to?: Date;
    interval?: 'hour' | 'day' | 'week' | 'month';
  } = {},
): Promise<any[]> {
  const db = getDb();
  const tableName = getEventTableName(idl, eventName);
  let query: Knex.QueryBuilder<any, any> = db(tableName);
  const allowedIntervals = new Set(['hour', 'day', 'week', 'month']);

  if (options.from) query = query.where('block_time', '>=', options.from);
  if (options.to) query = query.where('block_time', '<=', options.to);

  if (options.interval) {
    if (!allowedIntervals.has(options.interval)) {
      throw new Error(`Invalid interval: ${options.interval}`);
    }

    const expr = `date_trunc('${options.interval}', block_time)`;
    query = query
      .select(db.raw(`${expr} as period`))
      .count('* as count')
      .groupByRaw(expr)
      .orderByRaw(`${expr} ASC`);
  } else if (options.groupBy) {
    const col = sanitizeSqlName(options.groupBy);
    query = query.select(col).count('* as count').groupBy(col).orderBy('count', 'desc');
  } else {
    query = query.count('* as count');
  }

  return await query;
}

export async function queryAccountHistory(
  idl: AnchorIdl,
  accountName: string,
  pubkey: string,
  filters: QueryFilters = {},
  options: { limit?: number; offset?: number; order?: 'asc' | 'desc' } = {},
): Promise<any[]> {
  const db = getDb();
  const tableName = getAccountHistoryTableName(idl, accountName);
  let query: Knex.QueryBuilder<any, any> = applyFilters(
    db(tableName).where('pubkey', pubkey),
    filters,
  );

  query = query.orderBy('slot', options.order || 'desc').orderBy('id', options.order || 'desc');
  if (options.limit !== undefined) query = query.limit(options.limit);
  if (options.offset !== undefined) query = query.offset(options.offset);

  return await query;
}

export async function countAccountHistory(
  idl: AnchorIdl,
  accountName: string,
  pubkey: string,
  filters: QueryFilters = {},
): Promise<number> {
  const db = getDb();
  const tableName = getAccountHistoryTableName(idl, accountName);
  const result = await applyFilters(
    db(tableName).where('pubkey', pubkey),
    filters,
  ).count('* as total').first();

  return Number.parseInt(String(result?.total ?? 0), 10);
}

export async function getProgramStats(idl: AnchorIdl): Promise<{
  totalTransactions: number;
  successfulTransactions: number;
  failedTransactions: number;
  instructionCounts: Record<string, number>;
  eventCounts: Record<string, number>;
  accountCounts: Record<string, number>;
  firstIndexedAt: Date | null;
  lastIndexedAt: Date | null;
}> {
  const db = getDb();

  const txStats = await db('_transactions')
    .select(
      db.raw('COUNT(*) as total'),
      db.raw('COUNT(*) FILTER (WHERE success = true) as success_count'),
      db.raw('COUNT(*) FILTER (WHERE success = false) as fail_count'),
      db.raw('MIN(indexed_at) as first_indexed'),
      db.raw('MAX(indexed_at) as last_indexed'),
    )
    .first();

  const instructionCounts: Record<string, number> = {};
  for (const ix of idl.instructions) {
    const tableName = getInstructionTableName(idl, ix.name);
    try {
      const result = await db(tableName).count('* as count').first();
      instructionCounts[ix.name] = Number.parseInt(String(result?.count ?? 0), 10);
    } catch {
      instructionCounts[ix.name] = 0;
    }
  }

  const eventCounts: Record<string, number> = {};
  for (const event of idl.events ?? []) {
    const tableName = getEventTableName(idl, event.name);
    try {
      const result = await db(tableName).count('* as count').first();
      eventCounts[event.name] = Number.parseInt(String(result?.count ?? 0), 10);
    } catch {
      eventCounts[event.name] = 0;
    }
  }

  const accountCounts: Record<string, number> = {};
  if (idl.accounts) {
    for (const acc of idl.accounts) {
      const tableName = getAccountTableName(idl, acc.name);
      try {
        const result = await db(tableName).count('* as count').first();
        accountCounts[acc.name] = Number.parseInt(String(result?.count ?? 0), 10);
      } catch {
        accountCounts[acc.name] = 0;
      }
    }
  }

  return {
    totalTransactions: Number.parseInt(String(txStats?.total ?? 0), 10),
    successfulTransactions: Number.parseInt(String(txStats?.success_count ?? 0), 10),
    failedTransactions: Number.parseInt(String(txStats?.fail_count ?? 0), 10),
    instructionCounts,
    eventCounts,
    accountCounts,
    firstIndexedAt: txStats?.first_indexed ?? null,
    lastIndexedAt: txStats?.last_indexed ?? null,
  };
}
