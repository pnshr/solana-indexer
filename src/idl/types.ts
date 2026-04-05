/**
 * Anchor IDL Type Definitions
 *
 * Supports Anchor IDL format used in v0.29+ (the "new" IDL format).
 * Also provides backward compatibility shims for the legacy format.
 *
 * Key design decision: we model IDL types as a discriminated union
 * so TypeScript can narrow types safely in the schema generator.
 */

// ─── Primitive types ───
export type IdlPrimitiveType =
  | 'bool'
  | 'u8' | 'u16' | 'u32' | 'u64' | 'u128'
  | 'i8' | 'i16' | 'i32' | 'i64' | 'i128' | 'i256'
  | 'u256'
  | 'f32' | 'f64'
  | 'string'
  | 'publicKey' | 'pubkey'
  | 'bytes';

// ─── Compound types ───
export interface IdlTypeVec {
  vec: IdlType;
}

export interface IdlTypeOption {
  option: IdlType;
}

export interface IdlTypeDefined {
  defined: string;
}

export interface IdlTypeArray {
  array: [IdlType, number];
}

export interface IdlTypeCOption {
  coption: IdlType;
}

export type IdlType =
  | IdlPrimitiveType
  | IdlTypeVec
  | IdlTypeOption
  | IdlTypeDefined
  | IdlTypeArray
  | IdlTypeCOption;

// ─── Field ───
export interface IdlField {
  name: string;
  type: IdlType;
  docs?: string[];
}

// ─── Enum variant ───
export interface IdlEnumVariant {
  name: string;
  fields?: IdlField[] | IdlType[];
}

// ─── Type definition (struct or enum) ───
export interface IdlTypeDef {
  name: string;
  docs?: string[];
  type: {
    kind: 'struct' | 'enum';
    fields?: IdlField[];
    variants?: IdlEnumVariant[];
  };
}

// ─── Account definition ───
export interface IdlAccountDef {
  name: string;
  docs?: string[];
  discriminator?: number[];
  type: {
    kind: 'struct';
    fields: IdlField[];
  };
}

// ─── Instruction account ───
export interface IdlInstructionAccount {
  name: string;
  isMut: boolean;
  isSigner: boolean;
  isOptional?: boolean;
  docs?: string[];
}

// ─── Instruction ───
export interface IdlInstruction {
  name: string;
  docs?: string[];
  accounts: IdlInstructionAccount[];
  args: IdlField[];
  discriminator?: number[];
}

// ─── Event ───
export interface IdlEvent {
  name: string;
  docs?: string[];
  fields: IdlField[];
  discriminator?: number[];
}

// ─── Top-level IDL ───
export interface AnchorIdl {
  version: string;
  name: string;
  metadata?: {
    address?: string;
    [key: string]: unknown;
  };
  instructions: IdlInstruction[];
  accounts?: IdlAccountDef[];
  types?: IdlTypeDef[];
  events?: IdlEvent[];
  errors?: Array<{
    code: number;
    name: string;
    msg?: string;
  }>;
}
