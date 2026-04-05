import path from 'path';
import { loadIdl } from '../idl/parser';
import { TransactionDecoder } from './index';

jest.mock('../config', () => ({
  config: { logLevel: 'error' },
}));

describe('TransactionDecoder', () => {
  it('accepts legacy Anchor IDLs without explicit discriminators', () => {
    const idl = loadIdl(path.resolve(__dirname, '../../test-idl.json'));

    expect(() => new TransactionDecoder(idl, '11111111111111111111111111111111')).not.toThrow();
  });

  it('assigns unique instruction indices for CPI instructions after top-level instructions', () => {
    const idl = loadIdl(path.resolve(__dirname, '../../test-idl.json'));
    const decoder = new TransactionDecoder(idl, '11111111111111111111111111111111');
    const decodeInstructionSpy = jest
      .spyOn(decoder as any, 'decodeInstruction')
      .mockImplementation((...args: any[]) => ({
        name: args[0]._name,
        args: {},
        accounts: {},
        instructionIndex: args[2],
      }));

    const tx = {
      transaction: {
        message: {
          accountKeys: ['11111111111111111111111111111111'],
          instructions: [
            { _name: 'initialize', data: 'ignored', programIdIndex: 0 },
            { _name: 'deposit', data: 'ignored', programIdIndex: 0 },
          ],
        },
      },
      meta: {
        innerInstructions: [
          {
            index: 0,
            instructions: [{ _name: 'withdraw', data: 'ignored', programIdIndex: 0 }],
          },
        ],
      },
    };

    const decoded = decoder.decodeTransaction(tx, 'sig-1');

    expect(decoded.map((ix) => ix.instructionIndex)).toEqual([0, 1, 2]);
    expect(new Set(decoded.map((ix) => ix.instructionIndex)).size).toBe(decoded.length);
    expect(decodeInstructionSpy).toHaveBeenCalledTimes(3);
  });
});
