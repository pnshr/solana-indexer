import { loadIdl, toSnakeCase, sanitizeSqlName } from './parser';
import fs from 'fs';
import os from 'os';
import path from 'path';

// Mock config so logger doesn't fail
jest.mock('../config', () => ({
  config: { logLevel: 'error' },
}));

describe('IDL Parser', () => {
  describe('toSnakeCase', () => {
    it('converts camelCase to snake_case', () => {
      expect(toSnakeCase('vaultBump')).toBe('vault_bump');
      expect(toSnakeCase('maxCapacity')).toBe('max_capacity');
      expect(toSnakeCase('totalDeposited')).toBe('total_deposited');
    });

    it('handles already snake_case strings', () => {
      expect(toSnakeCase('vault_bump')).toBe('vault_bump');
    });

    it('handles single words', () => {
      expect(toSnakeCase('amount')).toBe('amount');
    });

    it('handles PascalCase', () => {
      expect(toSnakeCase('VaultStatus')).toBe('vault_status');
    });
  });

  describe('sanitizeSqlName', () => {
    it('produces valid SQL identifiers', () => {
      expect(sanitizeSqlName('vaultBump')).toBe('vault_bump');
      expect(sanitizeSqlName('token-account')).toBe('token_account');
      expect(sanitizeSqlName('my.field')).toBe('my_field');
    });

    it('bounds identifiers to PostgreSQL limits deterministically', () => {
      const longName = 'ThisIsAnExtremelyLongIdentifierNameThatWouldOverflowPostgresIdentifierLimitsIfLeftUntouched';
      const sanitized = sanitizeSqlName(longName);

      expect(sanitized.length).toBeLessThanOrEqual(63);
      expect(sanitizeSqlName(longName)).toBe(sanitized);
    });
  });

  describe('loadIdl', () => {
    const testIdlPath = path.resolve(__dirname, '../../test-idl.json');

    it('loads and parses a valid IDL file', () => {
      const idl = loadIdl(testIdlPath);

      expect(idl.name).toBe('token_vault');
      expect(idl.version).toBe('0.1.0');
      expect(idl.instructions).toHaveLength(3);
      expect(idl.accounts).toHaveLength(1);
      expect(idl.types).toHaveLength(1);
      expect(idl.events).toHaveLength(1);
    });

    it('correctly parses instruction details', () => {
      const idl = loadIdl(testIdlPath);
      const deposit = idl.instructions.find((ix) => ix.name === 'deposit');

      expect(deposit).toBeDefined();
      expect(deposit!.accounts).toHaveLength(4);
      expect(deposit!.args).toHaveLength(1);
      expect(deposit!.args[0].name).toBe('amount');
      expect(deposit!.args[0].type).toBe('u64');
    });

    it('correctly parses account definitions', () => {
      const idl = loadIdl(testIdlPath);
      const vault = idl.accounts![0];

      expect(vault.name).toBe('Vault');
      expect(vault.type.kind).toBe('struct');
      expect(vault.type.fields).toHaveLength(6);
    });

    it('normalizes isMut/isSigner defaults', () => {
      const idl = loadIdl(testIdlPath);
      const ix = idl.instructions[0];

      for (const acc of ix.accounts) {
        expect(typeof acc.isMut).toBe('boolean');
        expect(typeof acc.isSigner).toBe('boolean');
      }
    });

    it('throws on missing file', () => {
      expect(() => loadIdl('/nonexistent/path.json')).toThrow('IDL file not found');
    });

    it('supports newer IDLs with name/version in metadata', () => {
      const tempPath = path.join(os.tmpdir(), `anchor-idl-${Date.now()}.json`);
      fs.writeFileSync(tempPath, JSON.stringify({
        metadata: {
          name: 'modern_program',
          version: '1.2.3',
        },
        instructions: [],
        accounts: [],
        types: [
          {
            name: 'MyEvent',
            type: {
              kind: 'struct',
              fields: [{ name: 'amount', type: 'u64' }],
            },
          },
        ],
        events: [
          {
            name: 'MyEvent',
            discriminator: [1, 2, 3, 4, 5, 6, 7, 8],
          },
        ],
      }));

      try {
        const idl = loadIdl(tempPath);
        expect(idl.name).toBe('modern_program');
        expect(idl.version).toBe('1.2.3');
        expect(idl.events?.[0].fields).toEqual([{ name: 'amount', type: 'u64' }]);
      } finally {
        fs.unlinkSync(tempPath);
      }
    });

    it('throws on unresolved account struct definitions', () => {
      const tempPath = path.join(os.tmpdir(), `anchor-idl-bad-account-${Date.now()}.json`);
      fs.writeFileSync(tempPath, JSON.stringify({
        name: 'broken_program',
        version: '1.0.0',
        instructions: [],
        accounts: [{ name: 'Vault' }],
        types: [],
      }));

      try {
        expect(() => loadIdl(tempPath)).toThrow('missing a resolvable struct definition');
      } finally {
        fs.unlinkSync(tempPath);
      }
    });

    it('throws on sanitized instruction column collisions', () => {
      const tempPath = path.join(os.tmpdir(), `anchor-idl-collision-${Date.now()}.json`);
      fs.writeFileSync(tempPath, JSON.stringify({
        name: 'collision_program',
        version: '1.0.0',
        instructions: [
          {
            name: 'deposit',
            accounts: [],
            args: [
              { name: 'vaultBump', type: 'u8' },
              { name: 'vault_bump', type: 'u8' },
            ],
          },
        ],
        accounts: [],
        types: [],
      }));

      try {
        expect(() => loadIdl(tempPath)).toThrow('collision');
      } finally {
        fs.unlinkSync(tempPath);
      }
    });
  });
});
