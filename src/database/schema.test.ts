import { idlTypeToSqlType, makeConstraintName } from './schema';
import { AnchorIdl, IdlType } from '../idl/types';

// Mock config
jest.mock('../config', () => ({
  config: { logLevel: 'error' },
}));

const mockIdl: AnchorIdl = {
  version: '0.1.0',
  name: 'test',
  instructions: [],
  accounts: [],
  types: [
    {
      name: 'MyEnum',
      type: {
        kind: 'enum',
        variants: [{ name: 'A' }, { name: 'B' }],
      },
    },
    {
      name: 'MyStruct',
      type: {
        kind: 'struct',
        fields: [{ name: 'x', type: 'u64' }],
      },
    },
  ],
  events: [],
};

describe('Schema Generator - Type Mapping', () => {
  describe('makeConstraintName', () => {
    it('does not duplicate the suffix in generated index names', () => {
      expect(makeConstraintName('transactions', ['slot'], 'idx')).toBe('transactions_slot_idx');
      expect(
        makeConstraintName('program_ix_transfer', ['signature', 'instruction_index'], 'uniq'),
      ).toBe('program_ix_transfer_signature_instruction_index_uniq');
    });
  });

  describe('idlTypeToSqlType', () => {
    // Primitive types
    it('maps bool to BOOLEAN', () => {
      expect(idlTypeToSqlType('bool', mockIdl)).toBe('BOOLEAN');
    });

    it('maps u8/i8/i16 to SMALLINT and u16 to INTEGER', () => {
      expect(idlTypeToSqlType('u8', mockIdl)).toBe('SMALLINT');
      expect(idlTypeToSqlType('i8', mockIdl)).toBe('SMALLINT');
      expect(idlTypeToSqlType('i16', mockIdl)).toBe('SMALLINT');
      expect(idlTypeToSqlType('u16', mockIdl)).toBe('INTEGER');
    });

    it('maps i32 to INTEGER and u32 to BIGINT', () => {
      expect(idlTypeToSqlType('i32', mockIdl)).toBe('INTEGER');
      expect(idlTypeToSqlType('u32', mockIdl)).toBe('BIGINT');
    });

    it('maps u64/i64 to NUMERIC (avoids overflow)', () => {
      expect(idlTypeToSqlType('u64', mockIdl)).toBe('NUMERIC');
      expect(idlTypeToSqlType('i64', mockIdl)).toBe('NUMERIC');
    });

    it('maps u128/i128/u256/i256 to NUMERIC', () => {
      expect(idlTypeToSqlType('u128', mockIdl)).toBe('NUMERIC');
      expect(idlTypeToSqlType('i128', mockIdl)).toBe('NUMERIC');
      expect(idlTypeToSqlType('u256', mockIdl)).toBe('NUMERIC');
    });

    it('maps f32/f64 to DOUBLE PRECISION', () => {
      expect(idlTypeToSqlType('f32', mockIdl)).toBe('DOUBLE PRECISION');
      expect(idlTypeToSqlType('f64', mockIdl)).toBe('DOUBLE PRECISION');
    });

    it('maps string to TEXT', () => {
      expect(idlTypeToSqlType('string', mockIdl)).toBe('TEXT');
    });

    it('maps bytes to BYTEA', () => {
      expect(idlTypeToSqlType('bytes', mockIdl)).toBe('BYTEA');
    });

    it('maps publicKey/pubkey to VARCHAR(44)', () => {
      expect(idlTypeToSqlType('publicKey', mockIdl)).toBe('VARCHAR(44)');
      expect(idlTypeToSqlType('pubkey', mockIdl)).toBe('VARCHAR(44)');
    });

    // Complex types
    it('maps vec to JSONB', () => {
      expect(idlTypeToSqlType({ vec: 'u64' }, mockIdl)).toBe('JSONB');
    });

    it('maps option to the inner type', () => {
      expect(idlTypeToSqlType({ option: 'u64' }, mockIdl)).toBe('NUMERIC');
      expect(idlTypeToSqlType({ option: 'string' }, mockIdl)).toBe('TEXT');
    });

    it('maps array to JSONB', () => {
      expect(idlTypeToSqlType({ array: ['u8', 32] }, mockIdl)).toBe('JSONB');
    });

    it('maps defined enum to TEXT', () => {
      expect(idlTypeToSqlType({ defined: 'MyEnum' }, mockIdl)).toBe('TEXT');
    });

    it('maps defined struct to JSONB', () => {
      expect(idlTypeToSqlType({ defined: 'MyStruct' }, mockIdl)).toBe('JSONB');
    });
  });
});
