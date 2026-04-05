import { Knex } from 'knex';
import { createHash } from 'crypto';
import { createChildLogger } from '../utils/logger';
import { AnchorIdl, IdlType, IdlField, IdlInstruction, IdlAccountDef, IdlEvent } from '../idl/types';
import { sanitizeSqlName } from '../idl/parser';
import { metrics } from '../observability/metrics';

const log = createChildLogger('schema-generator');
type ColumnSpec = { name: string; sqlType: string };

const TRANSACTION_INDEX_COLUMNS = [['slot'], ['block_time']] as const;
const INSTRUCTION_BASE_COLUMNS: ColumnSpec[] = [
  { name: 'id', sqlType: 'BIGINT' },
  { name: 'signature', sqlType: 'VARCHAR(128)' },
  { name: 'slot', sqlType: 'BIGINT' },
  { name: 'block_time', sqlType: 'TIMESTAMPTZ' },
  { name: 'instruction_index', sqlType: 'INTEGER' },
  { name: 'indexed_at', sqlType: 'TIMESTAMPTZ' },
];
const ACCOUNT_BASE_COLUMNS: ColumnSpec[] = [
  { name: 'pubkey', sqlType: 'VARCHAR(44)' },
  { name: 'slot', sqlType: 'BIGINT' },
  { name: 'owner', sqlType: 'VARCHAR(44)' },
  { name: 'lamports', sqlType: 'BIGINT' },
  { name: 'last_updated', sqlType: 'TIMESTAMPTZ' },
];
const ACCOUNT_HISTORY_BASE_COLUMNS: ColumnSpec[] = [
  { name: 'id', sqlType: 'BIGINT' },
  { name: 'pubkey', sqlType: 'VARCHAR(44)' },
  { name: 'slot', sqlType: 'BIGINT' },
  { name: 'owner', sqlType: 'VARCHAR(44)' },
  { name: 'lamports', sqlType: 'BIGINT' },
  { name: 'source_kind', sqlType: 'VARCHAR(16)' },
  { name: 'source_ref', sqlType: 'VARCHAR(160)' },
  { name: 'signature', sqlType: 'VARCHAR(128)' },
  { name: 'captured_at', sqlType: 'TIMESTAMPTZ' },
];
const EVENT_BASE_COLUMNS: ColumnSpec[] = [
  { name: 'id', sqlType: 'BIGINT' },
  { name: 'signature', sqlType: 'VARCHAR(128)' },
  { name: 'slot', sqlType: 'BIGINT' },
  { name: 'block_time', sqlType: 'TIMESTAMPTZ' },
  { name: 'event_index', sqlType: 'INTEGER' },
  { name: 'indexed_at', sqlType: 'TIMESTAMPTZ' },
];

/**
 * Maps an IDL type to a PostgreSQL column type.
 *
 * Design notes:
 * - u64/i64/u128/i128 → NUMERIC because PG BIGINT can't hold u128 and
 *   JS Number can't safely represent u64.
 * - publicKey/pubkey → VARCHAR(44) for base58 Solana addresses.
 * - Nested structs (defined) → JSONB. Sacrifices direct SQL queryability
 *   for schema simplicity. Alternative (flatten) would cause column explosion
 *   on deeply nested types.
 * - Enums → TEXT. Stores the variant name as a string.
 */
export function idlTypeToSqlType(idlType: IdlType, idl: AnchorIdl): string {
  if (typeof idlType === 'string') {
    switch (idlType) {
      case 'bool': return 'BOOLEAN';
      case 'u8': case 'i8': case 'i16': return 'SMALLINT';
      // u16 max (65 535) exceeds SMALLINT max (32 767) → INTEGER
      case 'u16': case 'i32': return 'INTEGER';
      // u32 max (4 294 967 295) exceeds INTEGER max (2 147 483 647) → BIGINT
      case 'u32': return 'BIGINT';
      case 'u64': case 'i64': return 'NUMERIC';
      case 'u128': case 'i128': case 'u256': case 'i256': return 'NUMERIC';
      case 'f32': case 'f64': return 'DOUBLE PRECISION';
      case 'string': return 'TEXT';
      case 'bytes': return 'BYTEA';
      case 'publicKey': case 'pubkey': return 'VARCHAR(44)';
      default: return 'JSONB';
    }
  }

  if ('vec' in idlType) return 'JSONB';
  if ('option' in idlType) return idlTypeToSqlType(idlType.option, idl);
  if ('coption' in idlType) return idlTypeToSqlType(idlType.coption, idl);
  if ('array' in idlType) return 'JSONB';
  if ('defined' in idlType) {
    const typeDef = idl.types?.find((t) => t.name === idlType.defined);
    if (typeDef && typeDef.type.kind === 'enum') return 'TEXT';
    return 'JSONB';
  }

  return 'JSONB';
}

function buildColumns(fields: IdlField[], idl: AnchorIdl) {
  return fields.map((field) => ({
    name: sanitizeSqlName(field.name),
    sqlType: idlTypeToSqlType(field.type, idl),
    originalName: field.name,
  }));
}

async function createMetaTables(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasTable('_indexer_state'))) {
    await knex.schema.createTable('_indexer_state', (t) => {
      t.string('key').primary();
      t.text('value').notNullable();
      t.timestamp('updated_at', { useTz: true }).defaultTo(knex.fn.now());
    });
    log.info('Created _indexer_state table');
  }

  if (!(await knex.schema.hasTable('_transactions'))) {
    await knex.schema.createTable('_transactions', (t) => {
      t.string('signature', 128).primary();
      t.bigInteger('slot').notNullable();
      t.timestamp('block_time', { useTz: true });
      t.boolean('success').notNullable();
      t.text('err').nullable();
      t.timestamp('indexed_at', { useTz: true }).defaultTo(knex.fn.now());
    });
    log.info('Created _transactions table');
  }

  if (!(await knex.schema.hasTable('_schema_revisions'))) {
    await knex.schema.createTable('_schema_revisions', (t) => {
      t.bigIncrements('id').primary();
      t.string('program_name', 128).notNullable();
      t.string('program_id', 44).notNullable();
      t.string('idl_hash', 64).notNullable();
      t.jsonb('idl_json').notNullable();
      t.timestamp('applied_at', { useTz: true }).defaultTo(knex.fn.now());
      t.unique(['program_id', 'idl_hash']);
    });
    log.info('Created _schema_revisions table');
  }

  for (const columns of TRANSACTION_INDEX_COLUMNS) {
    await ensureIndex(knex, '_transactions', columns);
  }
}

async function createInstructionTable(knex: Knex, ix: IdlInstruction, idl: AnchorIdl): Promise<void> {
  const tableName = getInstructionTableName(idl, ix.name);
  const argColumns = buildColumns(ix.args, idl);
  const accountColumns = ix.accounts.map((acc) => ({
    name: sanitizeSqlName(`acc_${acc.name}`),
    sqlType: 'VARCHAR(44)',
  }));

  if (!(await knex.schema.hasTable(tableName))) {
    await knex.schema.createTable(tableName, (t) => {
      t.bigIncrements('id').primary();
      t.string('signature', 128).notNullable();
      t.bigInteger('slot').notNullable();
      t.timestamp('block_time', { useTz: true });
      t.integer('instruction_index').notNullable();

      for (const col of accountColumns) {
        t.specificType(col.name, col.sqlType).nullable();
      }

      for (const col of argColumns) {
        t.specificType(col.name, col.sqlType).nullable();
      }

      t.timestamp('indexed_at', { useTz: true }).defaultTo(knex.fn.now());
    });

    log.info({ table: tableName, args: argColumns.length, accounts: ix.accounts.length }, 'Created instruction table');
  } else {
    const existingColumns = await knex(tableName).columnInfo();
    assertRequiredColumns(tableName, existingColumns, INSTRUCTION_BASE_COLUMNS, 'instruction table');
    await ensureColumns(knex, tableName, [...accountColumns, ...argColumns]);
  }

  await ensureUniqueIndex(knex, tableName, ['signature', 'instruction_index']);
  await ensureIndex(knex, tableName, ['signature']);
  await ensureIndex(knex, tableName, ['slot']);
  await ensureIndex(knex, tableName, ['block_time']);
}

async function createAccountTable(knex: Knex, account: IdlAccountDef, idl: AnchorIdl): Promise<void> {
  const tableName = getAccountTableName(idl, account.name);
  const historyTableName = getAccountHistoryTableName(idl, account.name);
  const fieldColumns = buildColumns(account.type.fields, idl);

  if (!(await knex.schema.hasTable(tableName))) {
    await knex.schema.createTable(tableName, (t) => {
      t.string('pubkey', 44).primary();
      t.bigInteger('slot').notNullable();
      t.string('owner', 44).notNullable();
      t.bigInteger('lamports').notNullable();

      for (const col of fieldColumns) {
        t.specificType(col.name, col.sqlType).nullable();
      }

      t.timestamp('last_updated', { useTz: true }).defaultTo(knex.fn.now());
    });

    log.info({ table: tableName, fields: fieldColumns.length }, 'Created account table');
  } else {
    const existingColumns = await knex(tableName).columnInfo();
    assertRequiredColumns(tableName, existingColumns, ACCOUNT_BASE_COLUMNS, 'account table');
    await ensureColumns(knex, tableName, fieldColumns);
  }

  await ensureIndex(knex, tableName, ['slot']);
  await ensureIndex(knex, tableName, ['owner']);

  if (!(await knex.schema.hasTable(historyTableName))) {
    await knex.schema.createTable(historyTableName, (t) => {
      t.bigIncrements('id').primary();
      t.string('pubkey', 44).notNullable();
      t.bigInteger('slot').notNullable();
      t.string('owner', 44).notNullable();
      t.bigInteger('lamports').notNullable();
      t.string('source_kind', 16).notNullable();
      t.string('source_ref', 160).notNullable();
      t.string('signature', 128).nullable();

      for (const col of fieldColumns) {
        t.specificType(col.name, col.sqlType).nullable();
      }

      t.timestamp('captured_at', { useTz: true }).defaultTo(knex.fn.now());
    });

    log.info({ table: historyTableName, fields: fieldColumns.length }, 'Created account history table');
  } else {
    const existingColumns = await knex(historyTableName).columnInfo();
    assertRequiredColumns(historyTableName, existingColumns, ACCOUNT_HISTORY_BASE_COLUMNS, 'account history table');
    await ensureColumns(knex, historyTableName, fieldColumns);
  }

  await ensureUniqueIndex(knex, historyTableName, ['pubkey', 'source_ref']);
  await ensureIndex(knex, historyTableName, ['pubkey']);
  await ensureIndex(knex, historyTableName, ['slot']);
  await ensureIndex(knex, historyTableName, ['signature']);
  await bootstrapAccountHistory(knex, tableName, historyTableName, fieldColumns);
}

async function createEventTable(knex: Knex, event: IdlEvent, idl: AnchorIdl): Promise<void> {
  const tableName = getEventTableName(idl, event.name);
  const fieldColumns = buildColumns(event.fields, idl);

  if (!(await knex.schema.hasTable(tableName))) {
    await knex.schema.createTable(tableName, (t) => {
      t.bigIncrements('id').primary();
      t.string('signature', 128).notNullable();
      t.bigInteger('slot').notNullable();
      t.timestamp('block_time', { useTz: true });
      t.integer('event_index').notNullable();

      for (const col of fieldColumns) {
        t.specificType(col.name, col.sqlType).nullable();
      }

      t.timestamp('indexed_at', { useTz: true }).defaultTo(knex.fn.now());
    });

    log.info({ table: tableName, fields: fieldColumns.length }, 'Created event table');
  } else {
    const existingColumns = await knex(tableName).columnInfo();
    assertRequiredColumns(tableName, existingColumns, EVENT_BASE_COLUMNS, 'event table');
    await ensureColumns(knex, tableName, fieldColumns);
  }

  await ensureUniqueIndex(knex, tableName, ['signature', 'event_index']);
  await ensureIndex(knex, tableName, ['signature']);
  await ensureIndex(knex, tableName, ['slot']);
  await ensureIndex(knex, tableName, ['block_time']);
}

/**
 * Main entry: generates full database schema from an IDL.
 * Idempotent — skips tables that already exist.
 */
export async function generateSchema(knex: Knex, idl: AnchorIdl, programId: string): Promise<void> {
  const prefix = sanitizeSqlName(idl.name);
  log.info({ program: idl.name, prefix }, 'Generating database schema from IDL');

  await createMetaTables(knex);

  for (const ix of idl.instructions) {
    await createInstructionTable(knex, ix, idl);
  }

  if (idl.events) {
    for (const event of idl.events) {
      await createEventTable(knex, event, idl);
    }
  }

  if (idl.accounts) {
    for (const acc of idl.accounts) {
      await createAccountTable(knex, acc, idl);
    }
  }

  await recordSchemaRevision(knex, idl, programId);

  log.info({ prefix }, 'Schema generation complete');
}

export function getInstructionTableName(idl: AnchorIdl, ixName: string): string {
  return sanitizeSqlName(`${idl.name}_ix_${ixName}`);
}

export function getAccountTableName(idl: AnchorIdl, accountName: string): string {
  return sanitizeSqlName(`${idl.name}_acc_${accountName}`);
}

export function getAccountHistoryTableName(idl: AnchorIdl, accountName: string): string {
  return sanitizeSqlName(`${idl.name}_acc_${accountName}_history`);
}

export function getEventTableName(idl: AnchorIdl, eventName: string): string {
  return sanitizeSqlName(`${idl.name}_evt_${eventName}`);
}

async function bootstrapAccountHistory(
  knex: Knex,
  currentTableName: string,
  historyTableName: string,
  fieldColumns: ColumnSpec[],
): Promise<void> {
  const historyCount = await knex(historyTableName).count('* as total').first();
  if (Number.parseInt(String(historyCount?.total ?? 0), 10) > 0) {
    return;
  }

  const currentCount = await knex(currentTableName).count('* as total').first();
  if (Number.parseInt(String(currentCount?.total ?? 0), 10) === 0) {
    return;
  }

  const fieldColumnList = fieldColumns.map((column) => `"${column.name}"`);
  const insertColumns = [
    '"pubkey"',
    '"slot"',
    '"owner"',
    '"lamports"',
    '"source_kind"',
    '"source_ref"',
    '"signature"',
    '"captured_at"',
    ...fieldColumnList,
  ].join(', ');
  const selectColumns = [
    '"pubkey"',
    '"slot"',
    '"owner"',
    '"lamports"',
    `'bootstrap'`,
    `concat('bootstrap:', "slot")`,
    'NULL',
    '"last_updated"',
    ...fieldColumnList,
  ].join(', ');

  await knex.raw(
    `INSERT INTO "${historyTableName}" (${insertColumns}) SELECT ${selectColumns} FROM "${currentTableName}"`,
  );

  log.info(
    { currentTable: currentTableName, historyTable: historyTableName },
    'Bootstrapped account history from existing latest-state rows',
  );
}

async function ensureColumns(knex: Knex, tableName: string, columns: ColumnSpec[]): Promise<void> {
  const existingColumns = await knex(tableName).columnInfo();
  const missingColumns = columns.filter((column) => !existingColumns[column.name]);

  if (missingColumns.length === 0) {
    return;
  }

  await knex.schema.alterTable(tableName, (t) => {
    for (const column of missingColumns) {
      t.specificType(column.name, column.sqlType).nullable();
    }
  });

  log.info(
    { table: tableName, addedColumns: missingColumns.map((column) => column.name) },
    'Added missing columns to existing table',
  );
}

function assertRequiredColumns(
  tableName: string,
  existingColumns: Record<string, Knex.ColumnInfo>,
  requiredColumns: ColumnSpec[],
  tableKind: string,
): void {
  const missingColumns = requiredColumns
    .map((column) => column.name)
    .filter((column) => !existingColumns[column]);

  if (missingColumns.length > 0) {
    throw new Error(
      `Existing ${tableKind} "${tableName}" is missing required columns: ${missingColumns.join(', ')}`,
    );
  }
}

async function ensureIndex(
  knex: Knex,
  tableName: string,
  columns: readonly string[],
): Promise<void> {
  const indexName = makeConstraintName(tableName, columns, 'idx');
  const columnList = columns.map((column) => `"${column}"`).join(', ');
  await knex.raw(`CREATE INDEX IF NOT EXISTS "${indexName}" ON "${tableName}" (${columnList})`);
}

async function ensureUniqueIndex(
  knex: Knex,
  tableName: string,
  columns: readonly string[],
): Promise<void> {
  const indexName = makeConstraintName(tableName, columns, 'uniq');
  const columnList = columns.map((column) => `"${column}"`).join(', ');
  await knex.raw(`CREATE UNIQUE INDEX IF NOT EXISTS "${indexName}" ON "${tableName}" (${columnList})`);
}

export function makeConstraintName(tableName: string, columns: readonly string[], suffix: string): string {
  // Do NOT call sanitizeSqlName here — it would already truncate to 63 chars,
  // making the hash-based collision avoidance below unreachable dead code.
  // tableName and column names are already sanitized by callers.
  const rawName = `${tableName}_${columns.join('_')}_${suffix}`;

  if (rawName.length <= 63) {
    return rawName;
  }

  const hash = createHash('sha1').update(rawName).digest('hex').slice(0, 8);
  return `${rawName.slice(0, 54)}_${hash}`;
}

async function recordSchemaRevision(knex: Knex, idl: AnchorIdl, programId: string): Promise<void> {
  const idlJson = JSON.stringify(idl);
  const idlHash = createHash('sha256').update(idlJson).digest('hex');
  const latest = await knex('_schema_revisions')
    .where({ program_id: programId })
    .orderBy('applied_at', 'desc')
    .first();

  if (latest?.idl_hash === idlHash) {
    return;
  }

  await knex('_schema_revisions')
    .insert({
      program_name: idl.name,
      program_id: programId,
      idl_hash: idlHash,
      idl_json: idl,
      applied_at: knex.fn.now(),
    })
    .onConflict(['program_id', 'idl_hash'])
    .ignore();

  metrics.incrementCounter('solana_indexer_schema_revision_total', 1, {
    program: idl.name,
  });
  log.info({ program: idl.name, programId, idlHash: idlHash.slice(0, 12) }, 'Recorded schema revision');
}
