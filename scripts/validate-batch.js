const path = require('path');
const {
  assert,
  createPool,
  createValidationEnv,
  fixture,
  logStep,
  repoRoot,
  runCommand,
  waitForPostgres,
} = require('./lib/validation');
const { PublicKey } = require('@solana/web3.js');

const projectName = 'solana-indexer-batch-validation';
const postgresPort = 55436;
const databaseUrl = `postgresql://indexer:indexer@127.0.0.1:${postgresPort}/solana_indexer`;

const slotFixtures = {
  init: 100,
  depositA: 101,
  depositB: 102,
  withdraw: 103,
};

function buildTx(slot, accountKeys, success = true) {
  return {
    slot,
    blockTime: 1_710_000_000 + slot,
    meta: { err: success ? null : { custom: 1 } },
    transaction: {
      message: {
        accountKeys: accountKeys.map((pubkey) => ({ pubkey: new PublicKey(pubkey) })),
      },
    },
  };
}

function createFakeRpcClient(options) {
  let getMultipleAccountsInfoCall = 0;

  return {
    getProgramId() {
      return new PublicKey(options.programId);
    },
    async getTransactionBatch(signatures) {
      if (options.batchFailures?.size) {
        for (const signature of signatures) {
          if (options.batchFailures.has(signature)) {
            throw new Error(`synthetic rpc failure for ${signature}`);
          }
        }
      }

      return signatures.map((signature) => {
        if (options.nullTransactions?.has(signature)) {
          return null;
        }
        return options.transactionsBySignature.get(signature) ?? null;
      });
    },
    async getMultipleAccountsInfo(pubkeys) {
      const snapshot = options.accountInfoSnapshots?.[getMultipleAccountsInfoCall] ?? options.accountInfoSnapshots?.[options.accountInfoSnapshots.length - 1];
      getMultipleAccountsInfoCall += 1;
      return pubkeys.map((pubkey) => {
        if (!snapshot || pubkey.toBase58() !== fixture.values.vault) {
          return null;
        }
        return {
          executable: false,
          owner: new PublicKey(options.programId),
          data: Buffer.from(snapshot.label, 'utf8'),
          lamports: snapshot.lamports,
        };
      });
    },
    async getCurrentSlot() {
      return options.snapshotSlot ?? 999;
    },
    async getProgramAccounts() {
      return (options.programAccounts ?? []).map((entry) => ({
        pubkey: new PublicKey(entry.pubkey),
        account: {
          executable: false,
          owner: new PublicKey(options.programId),
          data: Buffer.from(entry.label, 'utf8'),
          lamports: entry.lamports,
        },
      }));
    },
    async getSignatures({ before }) {
      if (!before) {
        return options.signaturePages?.[0] ?? [];
      }
      const pages = options.signaturePages ?? [];
      for (let index = 0; index < pages.length; index += 1) {
        const last = pages[index][pages[index].length - 1];
        if (last?.signature === before) {
          return pages[index + 1] ?? [];
        }
      }
      return [];
    },
  };
}

function createFakeDecoder(accountQueue) {
  const instructionsBySignature = new Map([
    [fixture.values.sigInitialize, [
      {
        name: 'initialize',
        args: { vaultBump: 254, maxCapacity: '1000' },
        accounts: {
          vault: fixture.values.vault,
          authority: fixture.values.authority,
          systemProgram: fixture.values.owner,
        },
        instructionIndex: 0,
      },
    ]],
    [fixture.values.sigDepositA, [
      {
        name: 'deposit',
        args: { amount: '100' },
        accounts: {
          vault: fixture.values.vault,
          depositor: fixture.values.depositorA,
          tokenAccount: fixture.values.tokenAccountA,
          tokenProgram: fixture.values.tokenProgram,
        },
        instructionIndex: 0,
      },
    ]],
    [fixture.values.sigDepositB, [
      {
        name: 'deposit',
        args: { amount: '250' },
        accounts: {
          vault: fixture.values.vault,
          depositor: fixture.values.depositorB,
          tokenAccount: fixture.values.tokenAccountB,
          tokenProgram: fixture.values.tokenProgram,
        },
        instructionIndex: 0,
      },
    ]],
    [fixture.values.sigWithdraw, [
      {
        name: 'withdraw',
        args: { amount: '75', memo: 'resume-check' },
        accounts: {
          vault: fixture.values.vault,
          authority: fixture.values.authority,
          tokenAccount: fixture.values.tokenAccountA,
          tokenProgram: fixture.values.tokenProgram,
        },
        instructionIndex: 0,
      },
    ]],
  ]);

  const eventsBySignature = new Map([
    [fixture.values.sigDepositA, [
      {
        name: 'DepositEvent',
        data: {
          depositor: fixture.values.depositorA,
          amount: '100',
          timestamp: '1710000101',
        },
        eventIndex: 0,
      },
    ]],
    [fixture.values.sigDepositB, [
      {
        name: 'DepositEvent',
        data: {
          depositor: fixture.values.depositorB,
          amount: '250',
          timestamp: '1710000102',
        },
        eventIndex: 0,
      },
    ]],
  ]);

  return {
    decodeTransaction(_tx, signature) {
      return instructionsBySignature.get(signature) ?? [];
    },
    decodeEvents(_tx, signature) {
      return eventsBySignature.get(signature) ?? [];
    },
    decodeAccountAuto(_data, pubkey, owner, lamports, slot) {
      const next = accountQueue.shift();
      if (!next) {
        return null;
      }
      return {
        pubkey,
        name: 'Vault',
        data: {
          authority: fixture.values.authority,
          totalDeposited: next.totalDeposited,
          maxCapacity: '1000',
          depositCount: next.depositCount,
          isActive: true,
          bump: 254,
        },
        owner,
        lamports,
        slot,
      };
    },
  };
}

async function cleanup(pool) {
  if (pool) {
    await pool.end().catch(() => undefined);
  }

  await runCommand(
    'docker',
    ['compose', '-p', projectName, 'down', '-v', '--remove-orphans'],
    { cwd: repoRoot, allowFailure: true },
  ).catch(() => undefined);
}

async function resetIndexedTables(pool) {
  const tables = [
    fixture.tables.transactions,
    fixture.tables.state,
    fixture.tables.initialize,
    fixture.tables.deposit,
    fixture.tables.withdraw,
    fixture.tables.event,
    fixture.tables.account,
    fixture.tables.accountHistory,
  ];

  await pool.query(`TRUNCATE TABLE ${tables.map((name) => `"${name}"`).join(', ')} RESTART IDENTITY CASCADE`);
}

async function countRows(pool, tableName) {
  const result = await pool.query(`SELECT COUNT(*)::int AS total FROM "${tableName}"`);
  return result.rows[0].total;
}

async function getState(pool, key) {
  const result = await pool.query(`SELECT value FROM "${fixture.tables.state}" WHERE key = $1`, [key]);
  return result.rows[0]?.value ?? null;
}

async function expectCounts(pool, expected) {
  for (const [tableName, count] of Object.entries(expected)) {
    const actual = await countRows(pool, tableName);
    assert(actual === count, `Expected ${tableName} count=${count}, received ${actual}`);
  }
}

async function loadSourceModules() {
  Object.assign(process.env, createValidationEnv({
    DATABASE_URL: databaseUrl,
    API_PORT: '3300',
    API_HOST: '127.0.0.1',
    BATCH_SIZE: '2',
    BATCH_RESUME: 'true',
    INDEXER_DISABLE_RUN: 'false',
  }));

  require('ts-node/register/transpile-only');

  const { config } = require(path.join(repoRoot, 'src', 'config'));
  const { loadIdl } = require(path.join(repoRoot, 'src', 'idl', 'parser'));
  const { generateSchema } = require(path.join(repoRoot, 'src', 'database', 'schema'));
  const { getDb, testConnection, closeDb } = require(path.join(repoRoot, 'src', 'database', 'connection'));
  const { TransactionProcessor } = require(path.join(repoRoot, 'src', 'indexer', 'processor'));
  const { BatchIndexer } = require(path.join(repoRoot, 'src', 'indexer', 'batch'));

  return {
    config,
    loadIdl,
    generateSchema,
    getDb,
    testConnection,
    closeDb,
    TransactionProcessor,
    BatchIndexer,
  };
}

async function runSignatureListProof(modules, idl, pool) {
  logStep('Batch proof: signature-list mode writes generated tables and remains idempotent on replay');

  const accountQueue = [
    { totalDeposited: '0', depositCount: 0 },
    { totalDeposited: '100', depositCount: 1 },
  ];

  const rpcClient = createFakeRpcClient({
    programId: fixture.values.owner,
    transactionsBySignature: new Map([
      [fixture.values.sigInitialize, buildTx(slotFixtures.init, [fixture.values.vault, fixture.values.authority, fixture.values.owner])],
      [fixture.values.sigDepositA, buildTx(slotFixtures.depositA, [fixture.values.vault, fixture.values.depositorA, fixture.values.tokenAccountA, fixture.values.tokenProgram, fixture.values.owner])],
    ]),
    accountInfoSnapshots: [
      { label: 'vault:init', lamports: 3_500_000 },
      { label: 'vault:depositA', lamports: 3_600_000 },
    ],
  });

  modules.config.indexer.mode = 'batch';
  modules.config.indexer.batchSignatures = [fixture.values.sigInitialize, fixture.values.sigDepositA];
  modules.config.indexer.batchStartSlot = undefined;
  modules.config.indexer.batchEndSlot = undefined;
  modules.config.indexer.batchResume = true;
  modules.config.indexer.batchSize = 2;

  const processor = new modules.TransactionProcessor(idl, rpcClient);
  processor.decoder = createFakeDecoder(accountQueue);
  const indexer = new modules.BatchIndexer(rpcClient, processor);
  await indexer.run();

  await expectCounts(pool, {
    [fixture.tables.transactions]: 2,
    [fixture.tables.initialize]: 1,
    [fixture.tables.deposit]: 1,
    [fixture.tables.withdraw]: 0,
    [fixture.tables.event]: 1,
    [fixture.tables.account]: 1,
    [fixture.tables.accountHistory]: 2,
  });

  assert(await getState(pool, 'last_processed_signature') === fixture.values.sigDepositA, 'Expected last_processed_signature to point at the latest signature-list item');
  assert(await getState(pool, 'last_processed_slot') === String(slotFixtures.depositA), 'Expected last_processed_slot to match the latest processed slot');
  assert(await getState(pool, 'batch_checkpoint_context') === null, 'Expected batch checkpoint context to be cleared after success');
  assert(await getState(pool, 'batch_checkpoint_signature') === null, 'Expected batch checkpoint signature to be cleared after success');

  await indexer.run();
  await expectCounts(pool, {
    [fixture.tables.transactions]: 2,
    [fixture.tables.initialize]: 1,
    [fixture.tables.deposit]: 1,
    [fixture.tables.event]: 1,
    [fixture.tables.account]: 1,
    [fixture.tables.accountHistory]: 2,
  });
}

async function runCheckpointResumeProof(modules, idl, pool) {
  logStep('Batch proof: checkpoint persistence resumes a failed signature batch from the stored point');
  await resetIndexedTables(pool);

  modules.config.indexer.mode = 'batch';
  modules.config.indexer.batchSignatures = [
    fixture.values.sigInitialize,
    fixture.values.sigDepositA,
    fixture.values.sigWithdraw,
  ];
  modules.config.indexer.batchStartSlot = undefined;
  modules.config.indexer.batchEndSlot = undefined;
  modules.config.indexer.batchResume = true;
  modules.config.indexer.batchSize = 1;

  const firstRunRpc = createFakeRpcClient({
    programId: fixture.values.owner,
    transactionsBySignature: new Map([
      [fixture.values.sigInitialize, buildTx(slotFixtures.init, [fixture.values.vault, fixture.values.authority, fixture.values.owner])],
      [fixture.values.sigDepositA, buildTx(slotFixtures.depositA, [fixture.values.vault, fixture.values.depositorA, fixture.values.tokenAccountA, fixture.values.tokenProgram, fixture.values.owner])],
    ]),
    nullTransactions: new Set([fixture.values.sigDepositA]),
    accountInfoSnapshots: [
      { label: 'resume:init', lamports: 3_500_000 },
    ],
  });

  const firstRunProcessor = new modules.TransactionProcessor(idl, firstRunRpc);
  firstRunProcessor.decoder = createFakeDecoder([
    { totalDeposited: '0', depositCount: 0 },
  ]);
  const firstRunIndexer = new modules.BatchIndexer(firstRunRpc, firstRunProcessor);

  let aborted = false;
  try {
    await firstRunIndexer.run();
  } catch (error) {
    aborted = String(error.message).includes(fixture.values.sigDepositA);
  }
  assert(aborted, 'Expected the first checkpoint-resume run to abort on the synthetic failed signature');

  await expectCounts(pool, {
    [fixture.tables.transactions]: 1,
    [fixture.tables.initialize]: 1,
    [fixture.tables.deposit]: 0,
    [fixture.tables.withdraw]: 0,
    [fixture.tables.accountHistory]: 1,
  });
  assert(await getState(pool, 'last_processed_signature') === fixture.values.sigInitialize, 'Expected checkpoint to persist the last successful signature before abort');
  assert(await getState(pool, 'batch_checkpoint_signature') === fixture.values.sigInitialize, 'Expected batch checkpoint signature to track the last completed item');
  const batchContext = await getState(pool, 'batch_checkpoint_context');
  assert(Boolean(batchContext), 'Expected batch checkpoint context to be stored after an aborted run');

  const secondRunRpc = createFakeRpcClient({
    programId: fixture.values.owner,
    transactionsBySignature: new Map([
      [fixture.values.sigDepositA, buildTx(slotFixtures.depositA, [fixture.values.vault, fixture.values.depositorA, fixture.values.tokenAccountA, fixture.values.tokenProgram, fixture.values.owner])],
      [fixture.values.sigWithdraw, buildTx(slotFixtures.withdraw, [fixture.values.vault, fixture.values.authority, fixture.values.tokenAccountA, fixture.values.tokenProgram, fixture.values.owner])],
    ]),
    accountInfoSnapshots: [
      { label: 'resume:depositA', lamports: 3_600_000 },
      { label: 'resume:withdraw', lamports: 3_550_000 },
    ],
  });

  const secondRunProcessor = new modules.TransactionProcessor(idl, secondRunRpc);
  secondRunProcessor.decoder = createFakeDecoder([
    { totalDeposited: '100', depositCount: 1 },
    { totalDeposited: '25', depositCount: 1 },
  ]);
  const secondRunIndexer = new modules.BatchIndexer(secondRunRpc, secondRunProcessor);
  await secondRunIndexer.run();

  await expectCounts(pool, {
    [fixture.tables.transactions]: 3,
    [fixture.tables.initialize]: 1,
    [fixture.tables.deposit]: 1,
    [fixture.tables.withdraw]: 1,
    [fixture.tables.event]: 1,
    [fixture.tables.account]: 1,
    [fixture.tables.accountHistory]: 3,
  });
  assert(await getState(pool, 'last_processed_signature') === fixture.values.sigWithdraw, 'Expected resumed run to advance the last processed signature');
  assert(await getState(pool, 'last_processed_slot') === String(slotFixtures.withdraw), 'Expected resumed run to advance the last processed slot');
  assert(await getState(pool, 'batch_checkpoint_context') === null, 'Expected batch checkpoint context to be cleared after resumed success');
  assert(await getState(pool, 'batch_checkpoint_signature') === null, 'Expected batch checkpoint signature to be cleared after resumed success');
}

async function runSlotRangeProof(modules, idl, pool) {
  logStep('Batch proof: slot-range mode filters history, processes in chronological order, and snapshots program accounts');
  await resetIndexedTables(pool);

  const firstPage = Array.from({ length: 998 }, (_, index) => ({
    signature: `too-new-${1200 - index}`,
    slot: 1200 - index,
  }));
  firstPage.push(
    { signature: fixture.values.sigDepositB, slot: slotFixtures.depositB },
    { signature: fixture.values.sigDepositA, slot: slotFixtures.depositA },
  );

  modules.config.indexer.mode = 'batch';
  modules.config.indexer.batchSignatures = undefined;
  modules.config.indexer.batchStartSlot = 100;
  modules.config.indexer.batchEndSlot = 102;
  modules.config.indexer.batchResume = false;
  modules.config.indexer.batchSize = 2;

  const rpcClient = createFakeRpcClient({
    programId: fixture.values.owner,
    transactionsBySignature: new Map([
      [fixture.values.sigInitialize, buildTx(slotFixtures.init, [fixture.values.vault, fixture.values.authority, fixture.values.owner])],
      [fixture.values.sigDepositA, buildTx(slotFixtures.depositA, [fixture.values.vault, fixture.values.depositorA, fixture.values.tokenAccountA, fixture.values.tokenProgram, fixture.values.owner])],
      [fixture.values.sigDepositB, buildTx(slotFixtures.depositB, [fixture.values.vault, fixture.values.depositorB, fixture.values.tokenAccountB, fixture.values.tokenProgram, fixture.values.owner])],
    ]),
    signaturePages: [
      firstPage,
      [
        { signature: fixture.values.sigInitialize, slot: slotFixtures.init },
        { signature: 'too-old-099', slot: 99 },
      ],
    ],
    accountInfoSnapshots: [
      { label: 'slot-range:init', lamports: 3_500_000 },
      { label: 'slot-range:depositA', lamports: 3_600_000 },
      { label: 'slot-range:depositB', lamports: 3_850_000 },
    ],
    snapshotSlot: 500,
    programAccounts: [
      { pubkey: fixture.values.vault, label: 'slot-range:snapshot', lamports: 3_850_000 },
    ],
  });

  const processor = new modules.TransactionProcessor(idl, rpcClient);
  processor.decoder = createFakeDecoder([
    { totalDeposited: '0', depositCount: 0 },
    { totalDeposited: '100', depositCount: 1 },
    { totalDeposited: '350', depositCount: 2 },
    { totalDeposited: '350', depositCount: 2 },
  ]);
  const indexer = new modules.BatchIndexer(rpcClient, processor);
  await indexer.run();

  await expectCounts(pool, {
    [fixture.tables.transactions]: 3,
    [fixture.tables.initialize]: 1,
    [fixture.tables.deposit]: 2,
    [fixture.tables.withdraw]: 0,
    [fixture.tables.event]: 2,
    [fixture.tables.account]: 1,
  });

  const historySourceKinds = await pool.query(
    `SELECT source_kind, COUNT(*)::int AS total FROM "${fixture.tables.accountHistory}" GROUP BY source_kind ORDER BY source_kind ASC`,
  );
  const historyKinds = Object.fromEntries(historySourceKinds.rows.map((row) => [row.source_kind, row.total]));
  assert(historyKinds.snapshot === 1, 'Expected one snapshot account-history row from slot-range account indexing');
  assert(historyKinds.transaction === 3, 'Expected transaction-driven account-history rows from slot-range processing');
  assert(await getState(pool, 'last_processed_signature') === fixture.values.sigDepositB, 'Expected slot-range processing to finish on the highest in-range chronological signature');
  assert(await getState(pool, 'last_processed_slot') === String(slotFixtures.depositB), 'Expected slot-range processing to persist the highest in-range slot');
}

async function main() {
  let pool;
  let modules;

  try {
    logStep('Resetting Docker-backed PostgreSQL for batch integration validation');
    await cleanup();
    await runCommand(
      'docker',
      ['compose', '-p', projectName, 'up', '-d', 'postgres'],
      {
        cwd: repoRoot,
        env: {
          ...process.env,
          POSTGRES_PORT: String(postgresPort),
        },
      },
    );

    pool = createPool(databaseUrl);
    await waitForPostgres(pool);
    modules = await loadSourceModules();
    const idl = modules.loadIdl(path.join(repoRoot, 'test-idl.json'));

    await modules.testConnection();
    await modules.generateSchema(modules.getDb(), idl, fixture.values.owner);
    await resetIndexedTables(pool);

    await runSignatureListProof(modules, idl, pool);
    await runCheckpointResumeProof(modules, idl, pool);
    await runSlotRangeProof(modules, idl, pool);

    console.log('\nBatch integration validation succeeded.');
  } finally {
    if (modules?.closeDb) {
      await modules.closeDb().catch(() => undefined);
    }
    await cleanup(pool);
  }
}

main().catch((error) => {
  console.error('\nBatch integration validation failed.');
  console.error(error.message);
  process.exit(1);
});
