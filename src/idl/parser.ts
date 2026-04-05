import fs from 'fs';
import path from 'path';
import { createHash } from 'crypto';
import { createChildLogger } from '../utils/logger';
import { AnchorIdl, IdlAccountDef, IdlField, IdlType, IdlTypeDef } from './types';

const log = createChildLogger('idl-parser');
const PG_IDENTIFIER_MAX_LENGTH = 63;
const RESERVED_INSTRUCTION_COLUMNS = new Set(['id', 'signature', 'slot', 'block_time', 'instruction_index', 'indexed_at']);
const RESERVED_ACCOUNT_COLUMNS = new Set(['pubkey', 'slot', 'owner', 'lamports', 'last_updated']);
const RESERVED_EVENT_COLUMNS = new Set(['id', 'signature', 'slot', 'block_time', 'event_index', 'indexed_at']);

/**
 * Loads and normalizes an Anchor IDL from a JSON file.
 * Handles both old (pre-0.30) and new IDL formats.
 */
export function loadIdl(idlPath: string): AnchorIdl {
  const resolved = path.resolve(idlPath);
  log.info({ path: resolved }, 'Loading IDL file');

  if (!fs.existsSync(resolved)) {
    throw new Error(`IDL file not found: ${resolved}`);
  }

  const raw = fs.readFileSync(resolved, 'utf-8');
  let idl: AnchorIdl;

  try {
    idl = JSON.parse(raw);
  } catch (err) {
    throw new Error(`Failed to parse IDL JSON: ${(err as Error).message}`);
  }

  if (!idl.name && typeof idl.metadata?.name === 'string') {
    idl.name = idl.metadata.name;
  }
  if (!idl.version && typeof idl.metadata?.version === 'string') {
    idl.version = idl.metadata.version;
  }

  if (!idl.instructions || !Array.isArray(idl.instructions)) {
    throw new Error('IDL must contain an "instructions" array');
  }

  if (!idl.name) {
    throw new Error('IDL must contain a "name" field');
  }

  idl = normalizeIdl(idl);
  validateIdl(idl);

  log.info(
    {
      name: idl.name,
      version: idl.version,
      instructions: idl.instructions.length,
      accounts: idl.accounts?.length ?? 0,
      types: idl.types?.length ?? 0,
      events: idl.events?.length ?? 0,
    },
    'IDL loaded successfully',
  );

  return idl;
}

/**
 * Normalize IDL to handle differences between Anchor versions.
 * Ensures accounts, types, events arrays exist, resolves account type defs,
 * and converts field/type shapes to a stable internal representation.
 */
function normalizeIdl(idl: AnchorIdl): AnchorIdl {
  if (!idl.accounts) idl.accounts = [];
  if (!idl.types) idl.types = [];
  if (!idl.events) idl.events = [];

  for (const typeDef of idl.types) {
    normalizeTypeDef(typeDef);
  }

  const typeMap = new Map(idl.types.map((typeDef) => [typeDef.name, typeDef]));

  for (const account of idl.accounts) {
    normalizeAccount(account, typeMap);
  }

  for (const ix of idl.instructions) {
    ix.args = ix.args.map(normalizeField);

    for (const acc of ix.accounts) {
      if ((acc as any).writable !== undefined && acc.isMut === undefined) {
        acc.isMut = (acc as any).writable;
      }
      if ((acc as any).signer !== undefined && acc.isSigner === undefined) {
        acc.isSigner = (acc as any).signer;
      }
      if (acc.isMut === undefined) acc.isMut = false;
      if (acc.isSigner === undefined) acc.isSigner = false;
    }
  }

  for (const event of idl.events) {
    const eventFields = Array.isArray((event as any).fields)
      ? (event as any).fields
      : (typeMap.get(event.name)?.type.kind === 'struct' ? typeMap.get(event.name)?.type.fields : undefined);

    (event as any).fields = (eventFields ?? []).map(normalizeField);
  }

  return idl;
}

function normalizeAccount(account: IdlAccountDef, typeMap: Map<string, IdlTypeDef>): void {
  if (!(account as any).type) {
    const matchingType = typeMap.get(account.name);
    if (matchingType?.type.kind === 'struct' && matchingType.type.fields) {
      (account as any).type = {
        kind: 'struct',
        fields: matchingType.type.fields.map(normalizeField),
      };
    }
    return;
  }

  account.type.fields = account.type.fields.map(normalizeField);
}

function normalizeTypeDef(typeDef: IdlTypeDef): void {
  if (typeDef.type.kind === 'struct' && typeDef.type.fields) {
    typeDef.type.fields = typeDef.type.fields.map(normalizeField);
  }

  if (typeDef.type.kind === 'enum' && typeDef.type.variants) {
    for (const variant of typeDef.type.variants) {
      if (!variant.fields || variant.fields.length === 0) continue;

      if (isNamedFieldArray(variant.fields)) {
        variant.fields = variant.fields.map(normalizeField);
      } else {
        variant.fields = variant.fields.map(normalizeType);
      }
    }
  }
}

function normalizeField(field: IdlField): IdlField {
  return {
    ...field,
    type: normalizeType(field.type),
  };
}

function normalizeType(type: IdlType | any): IdlType {
  if (typeof type === 'string') {
    return (type === 'pubkey' ? 'publicKey' : type) as IdlType;
  }

  if ('vec' in type) {
    return { vec: normalizeType(type.vec) };
  }

  if ('option' in type) {
    return { option: normalizeType(type.option) };
  }

  if ('coption' in type) {
    return { coption: normalizeType(type.coption) };
  }

  if ('array' in type) {
    return { array: [normalizeType(type.array[0]), type.array[1]] };
  }

  if ('defined' in type) {
    if (typeof type.defined === 'string') {
      return { defined: type.defined };
    }

    if (typeof type.defined?.name === 'string') {
      return { defined: type.defined.name };
    }
  }

  return type;
}

function isNamedFieldArray(fields: unknown[]): fields is IdlField[] {
  return fields.every((field) => typeof field === 'object' && field !== null && 'name' in field && 'type' in field);
}

function validateIdl(idl: AnchorIdl): void {
  assertUniqueIdentifiers(
    idl.instructions.map((ix) => ({
      original: ix.name,
      sql: sanitizeSqlName(`${idl.name}_ix_${ix.name}`),
    })),
    'instruction table',
  );

  assertUniqueIdentifiers(
    (idl.accounts ?? []).map((account) => ({
      original: account.name,
      sql: sanitizeSqlName(`${idl.name}_acc_${account.name}`),
    })),
    'account table',
  );

  for (const ix of idl.instructions) {
    const generatedColumns = [
      ...ix.args.map((arg) => ({
        original: `arg:${arg.name}`,
        sql: sanitizeSqlName(arg.name),
      })),
      ...ix.accounts.map((account) => ({
        original: `account:${account.name}`,
        sql: sanitizeSqlName(`acc_${account.name}`),
      })),
    ];

    assertUniqueIdentifiers(generatedColumns, `instruction "${ix.name}" columns`, RESERVED_INSTRUCTION_COLUMNS);
  }

  for (const account of idl.accounts ?? []) {
    if (!account.type || account.type.kind !== 'struct' || !Array.isArray(account.type.fields)) {
      throw new Error(`Account "${account.name}" is missing a resolvable struct definition in the IDL`);
    }

    assertUniqueIdentifiers(
      account.type.fields.map((field) => ({
        original: field.name,
        sql: sanitizeSqlName(field.name),
      })),
      `account "${account.name}" columns`,
      RESERVED_ACCOUNT_COLUMNS,
    );
  }

  assertUniqueIdentifiers(
    (idl.events ?? []).map((event) => ({
      original: event.name,
      sql: sanitizeSqlName(`${idl.name}_evt_${event.name}`),
    })),
    'event table',
  );

  for (const event of idl.events ?? []) {
    if (!Array.isArray(event.fields)) {
      throw new Error(`Event "${event.name}" is missing a resolvable field definition in the IDL`);
    }

    assertUniqueIdentifiers(
      event.fields.map((field) => ({
        original: field.name,
        sql: sanitizeSqlName(field.name),
      })),
      `event "${event.name}" columns`,
      RESERVED_EVENT_COLUMNS,
    );
  }
}

function assertUniqueIdentifiers(
  identifiers: Array<{ original: string; sql: string }>,
  scope: string,
  reservedNames: ReadonlySet<string> = new Set(),
): void {
  const seen = new Map<string, string>();

  for (const identifier of identifiers) {
    if (reservedNames.has(identifier.sql)) {
      throw new Error(`IDL ${scope} contains reserved SQL identifier "${identifier.original}" -> "${identifier.sql}"`);
    }

    const existing = seen.get(identifier.sql);
    if (existing && existing !== identifier.original) {
      throw new Error(
        `IDL ${scope} collision: "${existing}" and "${identifier.original}" both map to "${identifier.sql}"`,
      );
    }

    seen.set(identifier.sql, identifier.original);
  }
}

/**
 * Convert camelCase to snake_case for database column names.
 */
export function toSnakeCase(str: string): string {
  return str
    .replace(/([A-Z])/g, '_$1')
    .toLowerCase()
    .replace(/^_/, '');
}

/**
 * Sanitize name for use as a SQL identifier.
 * Converts to snake_case and strips non-alphanumeric characters.
 */
export function sanitizeSqlName(name: string): string {
  const normalized = toSnakeCase(name)
    .replace(/[^a-z0-9_]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');

  const fallback = normalized || 'unnamed';
  if (fallback.length <= PG_IDENTIFIER_MAX_LENGTH) {
    return fallback;
  }

  const hash = createHash('sha1').update(fallback).digest('hex').slice(0, 8);
  return `${fallback.slice(0, PG_IDENTIFIER_MAX_LENGTH - hash.length - 1)}_${hash}`;
}
