import { BorshCoder, BorshInstructionCoder, BorshAccountsCoder, EventParser } from '@coral-xyz/anchor';
import { createHash } from 'crypto';
import { PublicKey } from '@solana/web3.js';
import bs58 from 'bs58';
import { createChildLogger } from '../utils/logger';
import { AnchorIdl, IdlInstruction } from '../idl/types';
import { DecodedInstruction, DecodedAccount, DecodedEvent } from '../database/repository';

const log = createChildLogger('decoder');

/**
 * Decoder wraps Anchor's BorshInstructionCoder and BorshAccountsCoder
 * to decode instructions and account data from raw transaction bytes.
 *
 * Uses Anchor's built-in coders which handle discriminator matching internally.
 * Trade-off: tight coupling to @coral-xyz/anchor version.
 * Benefit: battle-tested decoding, no manual discriminator computation.
 */
export class TransactionDecoder {
  private instructionCoder: BorshInstructionCoder;
  private accountsCoder: BorshAccountsCoder;
  private eventParser: EventParser | null;
  private idl: AnchorIdl;
  private programId: PublicKey;
  private instructionMap: Map<string, IdlInstruction>;

  constructor(idl: AnchorIdl, programId: string) {
    const anchorCompatibleIdl = buildAnchorCompatibleIdl(idl);
    this.programId = new PublicKey(programId);
    const coder = new BorshCoder(anchorCompatibleIdl as any);
    this.instructionCoder = coder.instruction;
    this.accountsCoder = coder.accounts;
    this.eventParser = idl.events && idl.events.length > 0
      ? new EventParser(this.programId, coder)
      : null;
    this.idl = idl;

    this.instructionMap = new Map();
    for (const ix of idl.instructions) {
      this.instructionMap.set(ix.name, ix);
    }

    log.info({ programId, instructions: this.instructionMap.size }, 'Decoder initialized');
  }

  /**
   * Decode all instructions from a parsed transaction belonging to our program.
   * Also processes inner instructions (CPI calls).
   */
  decodeTransaction(tx: any, signature: string): DecodedInstruction[] {
    const results: DecodedInstruction[] = [];
    if (!tx?.transaction?.message?.instructions) return results;

    const accountKeys = tx.transaction.message.accountKeys.map((k: any) =>
      typeof k === 'string' ? k : k.pubkey?.toString() ?? k.toString(),
    );

    // Top-level instructions
    const instructions = tx.transaction.message.instructions;
    const innerInstructionBase = instructions.length;
    for (let i = 0; i < instructions.length; i++) {
      const ix = instructions[i];
      const pid = ix.programId?.toString() ?? accountKeys[ix.programIdIndex];
      if (pid !== this.programId.toString()) continue;
      const decoded = this.decodeInstruction(ix, accountKeys, i);
      if (decoded) results.push(decoded);
    }

    // Inner instructions (CPI)
    if (tx.meta?.innerInstructions) {
      for (const inner of tx.meta.innerInstructions) {
        for (let j = 0; j < inner.instructions.length; j++) {
          const ix = inner.instructions[j];
          const pid = ix.programId?.toString() ?? accountKeys[ix.programIdIndex];
          if (pid !== this.programId.toString()) continue;
          const decoded = this.decodeInstruction(
            ix,
            accountKeys,
            innerInstructionBase + inner.index * 1000 + j,
          );
          if (decoded) results.push(decoded);
        }
      }
    }

    if (results.length > 0) {
      log.debug({ signature: signature.slice(0, 16), count: results.length }, 'Decoded instructions');
    }
    return results;
  }

  decodeEvents(tx: any, signature: string): DecodedEvent[] {
    if (!this.eventParser || !tx?.meta?.logMessages || !Array.isArray(tx.meta.logMessages)) {
      return [];
    }

    try {
      const parsed = Array.from(this.eventParser.parseLogs([...tx.meta.logMessages]));
      const results = parsed.map((event, index) => ({
        name: event.name,
        data: serializeValues(event.data),
        eventIndex: index,
      }));

      if (results.length > 0) {
        log.debug({ signature: signature.slice(0, 16), count: results.length }, 'Decoded events');
      }

      return results;
    } catch (err) {
      log.warn({ error: (err as Error).message, signature: signature.slice(0, 16) }, 'Failed to decode events');
      return [];
    }
  }

  private decodeInstruction(ix: any, accountKeys: string[], instructionIndex: number): DecodedInstruction | null {
    try {
      let data: Buffer;
      if (ix.data) {
        if (typeof ix.data === 'string') {
          data = Buffer.from(bs58.decode(ix.data));
        } else {
          data = Buffer.from(ix.data);
        }
      } else {
        return null;
      }

      const decoded = this.instructionCoder.decode(data);
      if (!decoded) return null;

      const ixDef = this.instructionMap.get(decoded.name);
      const accounts: Record<string, string> = {};

      if (ixDef && ix.accounts) {
        const ixAccKeys = ix.accounts.map((a: any) => {
          // Raw transaction: accounts are numeric indices into accountKeys
          if (typeof a === 'number') return accountKeys[a];
          // Already a string address
          if (typeof a === 'string') return a;
          // Wrapped object with a pubkey field (some RPC formats)
          if (a.pubkey != null) return a.pubkey.toString();
          // PublicKey instance from getParsedTransaction (PartiallyDecodedInstruction)
          return a.toString();
        });
        for (let i = 0; i < ixDef.accounts.length && i < ixAccKeys.length; i++) {
          accounts[ixDef.accounts[i].name] = ixAccKeys[i];
        }
      }

      return {
        name: decoded.name,
        args: serializeValues(decoded.data),
        accounts,
        instructionIndex,
      };
    } catch (err) {
      log.warn({ error: (err as Error).message, instructionIndex }, 'Failed to decode instruction');
      return null;
    }
  }

  decodeAccount(accountName: string, data: Buffer, pubkey: string, owner: string, lamports: number, slot: number): DecodedAccount | null {
    return this.decodeAccountInternal(accountName, data, pubkey, owner, lamports, slot, true);
  }

  decodeAccountAuto(data: Buffer, pubkey: string, owner: string, lamports: number, slot: number): DecodedAccount | null {
    if (!this.idl.accounts) return null;
    for (const accDef of this.idl.accounts) {
      const decoded = this.decodeAccountInternal(accDef.name, data, pubkey, owner, lamports, slot, false);
      if (decoded) return decoded;
    }
    return null;
  }

  getInstructionNames(): string[] { return Array.from(this.instructionMap.keys()); }
  getAccountNames(): string[] { return this.idl.accounts?.map((a) => a.name) ?? []; }

  private decodeAccountInternal(
    accountName: string,
    data: Buffer,
    pubkey: string,
    owner: string,
    lamports: number,
    slot: number,
    logFailures: boolean,
  ): DecodedAccount | null {
    try {
      const decoded = this.accountsCoder.decode(accountName, data);
      if (!decoded) return null;
      return { pubkey, name: accountName, data: serializeValues(decoded), owner, lamports, slot };
    } catch (err) {
      if (logFailures) {
        log.warn({ error: (err as Error).message, accountName, pubkey }, 'Failed to decode account');
      }
      return null;
    }
  }
}

function serializeValues(obj: any): any {
  if (obj === null || obj === undefined) return obj;
  if (typeof obj !== 'object') return obj;

  if (obj instanceof PublicKey || (obj._bn && obj.toBase58)) return obj.toBase58();

  if (obj.toNumber || (obj.toString && obj._hex !== undefined)) {
    try { const n = obj.toNumber(); if (Math.abs(n) < Number.MAX_SAFE_INTEGER) return n; } catch {}
    return obj.toString();
  }

  if (Buffer.isBuffer(obj)) return `\\x${obj.toString('hex')}`;
  if (obj instanceof Uint8Array) return `\\x${Buffer.from(obj).toString('hex')}`;
  if (Array.isArray(obj)) return obj.map(serializeValues);

  const result: Record<string, any> = {};
  for (const [key, value] of Object.entries(obj)) result[key] = serializeValues(value);
  return result;
}

function buildAnchorCompatibleIdl(idl: AnchorIdl): Record<string, any> {
  const clone: any = structuredClone(idl);
  clone.types = (clone.types ?? []).map((typeDef: any) => normalizeTypeDefForAnchor(typeDef));

  clone.instructions = clone.instructions.map((ix: any) => ({
    ...ix,
    discriminator: ensureDiscriminator(ix.discriminator, `global:${ix.name}`),
    args: ix.args.map((arg: any) => normalizeFieldForAnchor(arg)),
  }));

  clone.accounts = (clone.accounts ?? []).map((account: any) => ({
    ...account,
    discriminator: ensureDiscriminator(account.discriminator, `account:${account.name}`),
    type: account.type ? normalizeAccountTypeForAnchor(account.type) : account.type,
  }));
  clone.events = (clone.events ?? []).map((event: any) => ({
    ...event,
    discriminator: ensureDiscriminator(event.discriminator, `event:${event.name}`),
    fields: (event.fields ?? []).map((field: any) => normalizeFieldForAnchor(field)),
  }));

  const knownTypes = new Set(clone.types.map((typeDef: any) => typeDef.name));
  for (const account of clone.accounts) {
    if (account.type && !knownTypes.has(account.name)) {
      clone.types.push({
        name: account.name,
        type: normalizeAccountTypeForAnchor(account.type),
      });
      knownTypes.add(account.name);
    }
  }

  for (const event of clone.events) {
    if (event.fields && !knownTypes.has(event.name)) {
      clone.types.push({
        name: event.name,
        type: {
          kind: 'struct',
          fields: event.fields.map((field: any) => normalizeFieldForAnchor(field)),
        },
      });
      knownTypes.add(event.name);
    }
  }

  return clone;
}

function normalizeTypeDefForAnchor(typeDef: any): any {
  if (typeDef.type?.kind === 'struct' && typeDef.type.fields) {
    return {
      ...typeDef,
      type: {
        ...typeDef.type,
        fields: typeDef.type.fields.map((field: any) => normalizeFieldForAnchor(field)),
      },
    };
  }

  if (typeDef.type?.kind === 'enum' && typeDef.type.variants) {
    return {
      ...typeDef,
      type: {
        ...typeDef.type,
        variants: typeDef.type.variants.map((variant: any) => {
          if (!variant.fields || variant.fields.length === 0) {
            return variant;
          }

          if (isNamedAnchorFieldArray(variant.fields)) {
            return {
              ...variant,
              fields: variant.fields.map((field: any) => normalizeFieldForAnchor(field)),
            };
          }

          return {
            ...variant,
            fields: variant.fields.map((fieldType: any) => normalizeTypeForAnchor(fieldType)),
          };
        }),
      },
    };
  }

  return typeDef;
}

function normalizeAccountTypeForAnchor(type: any): any {
  if (type?.kind === 'struct' && type.fields) {
    return {
      ...type,
      fields: type.fields.map((field: any) => normalizeFieldForAnchor(field)),
    };
  }

  return type;
}

function normalizeFieldForAnchor(field: any): any {
  return {
    ...field,
    type: normalizeTypeForAnchor(field.type),
  };
}

function normalizeTypeForAnchor(type: any): any {
  if (typeof type === 'string') {
    return type === 'publicKey' ? 'pubkey' : type;
  }

  if ('vec' in type) {
    return { vec: normalizeTypeForAnchor(type.vec) };
  }

  if ('option' in type) {
    return { option: normalizeTypeForAnchor(type.option) };
  }

  if ('coption' in type) {
    return { coption: normalizeTypeForAnchor(type.coption) };
  }

  if ('array' in type) {
    return { array: [normalizeTypeForAnchor(type.array[0]), type.array[1]] };
  }

  if ('defined' in type) {
    if (typeof type.defined === 'string') {
      return { defined: { name: type.defined } };
    }

    return {
      defined: {
        ...type.defined,
        name: type.defined.name,
      },
    };
  }

  return type;
}

function ensureDiscriminator(existing: number[] | undefined, namespaceValue: string): number[] {
  if (existing && existing.length > 0) {
    return existing;
  }

  return Array.from(
    createHash('sha256')
      .update(namespaceValue)
      .digest()
      .subarray(0, 8),
  );
}

function isNamedAnchorFieldArray(fields: unknown[]): boolean {
  return fields.every((field) => typeof field === 'object' && field !== null && 'name' in field && 'type' in field);
}
