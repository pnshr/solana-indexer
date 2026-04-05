const path = require('path');
const { spawn } = require('child_process');
const { Pool } = require('pg');

const repoRoot = path.resolve(__dirname, '..', '..');
const testIdlPath = path.join(repoRoot, 'test-idl.json');
const authToken = 'reviewer-token';
const dummyProgramId = '11111111111111111111111111111111';

const fixture = {
  programName: 'token_vault',
  tables: {
    transactions: '_transactions',
    state: '_indexer_state',
    revisions: '_schema_revisions',
    initialize: 'token_vault_ix_initialize',
    deposit: 'token_vault_ix_deposit',
    withdraw: 'token_vault_ix_withdraw',
    event: 'token_vault_evt_deposit_event',
    account: 'token_vault_acc_vault',
    accountHistory: 'token_vault_acc_vault_history',
  },
  values: {
    owner: dummyProgramId,
    vault: 'So11111111111111111111111111111111111111112',
    authority: 'SysvarRent111111111111111111111111111111111',
    depositorA: 'Vote111111111111111111111111111111111111111',
    depositorB: 'Stake11111111111111111111111111111111111111',
    tokenAccountA: 'ATokenGPvbdGVxr1cW9cA4Lkfp1yYyqSCDtnznuaCG2q',
    tokenAccountB: 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr',
    tokenProgram: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
    sigInitialize: '2m8JdC8WqQ1vTUSYfATqNnSboP8Gr3HdWu3UwG2n7NXmqoQZnQXtNCmieYwgdENeo2ZgdKzac8AjtKq6HgMHqmpY',
    sigDepositA: '5Q544pzrR6xPD58x35H5TADaBrZEcD3xKhsR4H2UvepQP9enZ5bY3bT5iAG2wE8xmPKzWGLfvkYhpCYwH14r2raF',
    sigDepositB: '4dH92e9GdBJf1Py4pc7SCHgFbf5HS2Buuzqb96NnKobfyQp2Q2yKWCzUL3to2jjV2VYSZtPi7HefyetZRkJRTnpV',
    sigWithdraw: '3w7N7DbSt1MSQd6hw2yYB9H9n1tFoZT3zh7TBTtJUqvGjNFH6G6DqJziWSPi7ipoCbWQBaLtgBoQxGc1dQc5sKXf',
  },
};

function logStep(message) {
  console.log(`\n==> ${message}`);
}

function resolveCommand(command) {
  if (process.platform === 'win32' && command === 'npm') {
    return 'npm.cmd';
  }
  return command;
}

function quoteWindowsArg(value) {
  if (/^[A-Za-z0-9_./:\\=-]+$/.test(value)) {
    return value;
  }
  return `"${value.replace(/"/g, '\\"')}"`;
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function createValidationEnv(overrides = {}) {
  return {
    ...process.env,
    NODE_ENV: 'production',
    SOLANA_RPC_URL: 'http://127.0.0.1:8899',
    SOLANA_WS_URL: 'ws://127.0.0.1:8900',
    PROGRAM_ID: dummyProgramId,
    IDL_PATH: testIdlPath,
    INDEXER_MODE: 'batch',
    INDEXER_DISABLE_RUN: 'true',
    API_AUTH_TOKEN: authToken,
    API_RATE_LIMIT_WINDOW_MS: '60000',
    API_RATE_LIMIT_MAX_REQUESTS: '1000',
    ENABLE_METRICS: 'true',
    LOG_LEVEL: 'info',
    ...overrides,
  };
}

function runCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = process.platform === 'win32'
      ? spawn(
        'cmd.exe',
        [
          '/d',
          '/s',
          '/c',
          `${quoteWindowsArg(resolveCommand(command))} ${args.map(quoteWindowsArg).join(' ')}`,
        ],
        {
          cwd: options.cwd || repoRoot,
          env: options.env || process.env,
          shell: false,
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      )
      : spawn(resolveCommand(command), args, {
        cwd: options.cwd || repoRoot,
        env: options.env || process.env,
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
      });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
      if (options.inheritStdout) process.stdout.write(chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
      if (options.inheritStderr) process.stderr.write(chunk);
    });

    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0 || options.allowFailure) {
        resolve({ code, stdout, stderr });
        return;
      }

      reject(
        new Error(
          `${command} ${args.join(' ')} exited with code ${code}\nSTDOUT:\n${stdout}\nSTDERR:\n${stderr}`,
        ),
      );
    });
  });
}

function startProcess(command, args, options = {}) {
  const child = spawn(resolveCommand(command), args, {
    cwd: options.cwd || repoRoot,
    env: options.env || process.env,
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const stdoutLines = [];
  const stderrLines = [];

  const collectLines = (target, chunk) => {
    const lines = chunk
      .toString()
      .split(/\r?\n/)
      .map((line) => line.trimEnd())
      .filter(Boolean);
    target.push(...lines);
  };

  child.stdout.on('data', (chunk) => collectLines(stdoutLines, chunk));
  child.stderr.on('data', (chunk) => collectLines(stderrLines, chunk));

  return { child, stdoutLines, stderrLines };
}

async function stopProcess(handle, signal = 'SIGINT', timeoutMs = 15000) {
  const { child, stdoutLines, stderrLines } = handle;
  if (child.exitCode !== null) {
    return { code: child.exitCode, stdoutLines, stderrLines };
  }

  child.kill(signal);

  const exitCode = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error(`Process did not exit within ${timeoutMs}ms after ${signal}`));
    }, timeoutMs);

    child.once('exit', (code, exitSignal) => {
      clearTimeout(timer);
      resolve({ code, signal: exitSignal });
    });
  });

  return { code: exitCode.code, signal: exitCode.signal, stdoutLines, stderrLines };
}

async function waitForHttp(url, options = {}) {
  const deadline = Date.now() + (options.timeoutMs || 30000);
  let lastError = 'no response';

  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, {
        headers: options.headers || {},
      });

      if ((options.acceptStatus || ((status) => status === 200))(response.status)) {
        return response;
      }

      lastError = `unexpected status ${response.status}`;
    } catch (error) {
      lastError = error.message;
    }

    await sleep(500);
  }

  throw new Error(`Timed out waiting for ${url}: ${lastError}`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createPool(databaseUrl) {
  return new Pool({
    connectionString: databaseUrl,
  });
}

async function waitForPostgres(pool, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = 'not started';

  while (Date.now() < deadline) {
    try {
      await pool.query('SELECT 1');
      return;
    } catch (error) {
      lastError = error.message;
      await sleep(500);
    }
  }

  throw new Error(`Timed out waiting for PostgreSQL: ${lastError}`);
}

function extractJsonLogLine(lines) {
  for (const line of lines) {
    const start = line.indexOf('{');
    if (start >= 0) {
      try {
        return JSON.parse(line.slice(start));
      } catch {
        continue;
      }
    }
  }
  return null;
}

function verifyStructuredLogs(lines) {
  const logLine = extractJsonLogLine(lines);
  assert(logLine, 'Expected at least one structured JSON log line');
  assert(logLine.service === 'solana-indexer', 'Expected structured log to include service=solana-indexer');
  assert(typeof logLine.component === 'string', 'Expected structured log to include component');
  assert(typeof logLine.msg === 'string', 'Expected structured log to include msg');
}

async function verifySchema(pool) {
  logStep('Verifying generated schema and PostgreSQL type mapping');

  const tablesResult = await pool.query(
    `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'`,
  );
  const tables = new Set(tablesResult.rows.map((row) => row.table_name));

  for (const tableName of Object.values(fixture.tables)) {
    assert(tables.has(tableName), `Expected generated table ${tableName}`);
  }

  const requiredColumns = [
    [fixture.tables.deposit, 'amount', 'numeric'],
    [fixture.tables.account, 'authority', 'character varying'],
    [fixture.tables.account, 'is_active', 'boolean'],
    [fixture.tables.event, 'timestamp', 'numeric'],
    [fixture.tables.accountHistory, 'source_kind', 'character varying'],
  ];

  for (const [tableName, columnName, expectedType] of requiredColumns) {
    const result = await pool.query(
      `SELECT data_type FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1 AND column_name = $2`,
      [tableName, columnName],
    );
    assert(result.rows.length === 1, `Expected column ${tableName}.${columnName}`);
    assert(
      result.rows[0].data_type === expectedType,
      `Expected ${tableName}.${columnName} to be ${expectedType}, received ${result.rows[0].data_type}`,
    );
  }

  const revisionResult = await pool.query(`SELECT COUNT(*)::int AS total FROM "${fixture.tables.revisions}"`);
  assert(revisionResult.rows[0].total >= 1, 'Expected _schema_revisions to contain at least one entry');
}

async function seedValidationData(pool) {
  logStep('Seeding deterministic validation data');

  const truncateTables = [
    fixture.tables.transactions,
    fixture.tables.state,
    fixture.tables.initialize,
    fixture.tables.deposit,
    fixture.tables.withdraw,
    fixture.tables.event,
    fixture.tables.account,
    fixture.tables.accountHistory,
  ].map((tableName) => `"${tableName}"`).join(', ');

  await pool.query(`TRUNCATE TABLE ${truncateTables} RESTART IDENTITY CASCADE`);

  await pool.query(
    `INSERT INTO "${fixture.tables.transactions}" (signature, slot, block_time, success, err)
     VALUES
       ($1, 99,  $2, true,  NULL),
       ($3, 100, $4, true,  NULL),
       ($5, 101, $6, true,  NULL),
       ($7, 102, $8, false, '{"custom":1}')`,
    [
      fixture.values.sigInitialize,
      '2024-01-01T00:00:00.000Z',
      fixture.values.sigDepositA,
      '2024-01-02T00:00:00.000Z',
      fixture.values.sigDepositB,
      '2024-01-03T00:00:00.000Z',
      fixture.values.sigWithdraw,
      '2024-01-04T00:00:00.000Z',
    ],
  );

  await pool.query(
    `INSERT INTO "${fixture.tables.state}" (key, value)
     VALUES
       ('last_processed_signature', $1),
       ('last_processed_slot', '102')`,
    [fixture.values.sigWithdraw],
  );

  await pool.query(
    `INSERT INTO "${fixture.tables.initialize}"
      (signature, slot, block_time, instruction_index, acc_vault, acc_authority, acc_system_program, vault_bump, max_capacity)
     VALUES ($1, 99, $2, 0, $3, $4, $5, 254, 1000)`,
    [
      fixture.values.sigInitialize,
      '2024-01-01T00:00:00.000Z',
      fixture.values.vault,
      fixture.values.authority,
      dummyProgramId,
    ],
  );

  await pool.query(
    `INSERT INTO "${fixture.tables.deposit}"
      (signature, slot, block_time, instruction_index, acc_vault, acc_depositor, acc_token_account, acc_token_program, amount)
     VALUES
      ($1, 100, $2, 0, $3, $4, $5, $6, 100),
      ($7, 101, $8, 0, $3, $9, $10, $6, 250)`,
    [
      fixture.values.sigDepositA,
      '2024-01-02T00:00:00.000Z',
      fixture.values.vault,
      fixture.values.depositorA,
      fixture.values.tokenAccountA,
      fixture.values.tokenProgram,
      fixture.values.sigDepositB,
      '2024-01-03T00:00:00.000Z',
      fixture.values.depositorB,
      fixture.values.tokenAccountB,
    ],
  );

  await pool.query(
    `INSERT INTO "${fixture.tables.withdraw}"
      (signature, slot, block_time, instruction_index, acc_vault, acc_authority, acc_token_account, acc_token_program, amount, memo)
     VALUES ($1, 102, $2, 0, $3, $4, $5, $6, 75, 'withdrawal-check')`,
    [
      fixture.values.sigWithdraw,
      '2024-01-04T00:00:00.000Z',
      fixture.values.vault,
      fixture.values.authority,
      fixture.values.tokenAccountA,
      fixture.values.tokenProgram,
    ],
  );

  await pool.query(
    `INSERT INTO "${fixture.tables.event}"
      (signature, slot, block_time, event_index, depositor, amount, timestamp)
     VALUES
      ($1, 100, $2, 0, $3, 100, 1704153600),
      ($4, 101, $5, 0, $6, 250, 1704240000)`,
    [
      fixture.values.sigDepositA,
      '2024-01-02T00:00:00.000Z',
      fixture.values.depositorA,
      fixture.values.sigDepositB,
      '2024-01-03T00:00:00.000Z',
      fixture.values.depositorB,
    ],
  );

  await pool.query(
    `INSERT INTO "${fixture.tables.account}"
      (pubkey, slot, owner, lamports, authority, total_deposited, max_capacity, deposit_count, is_active, bump, last_updated)
     VALUES ($1, 102, $2, 4000000, $3, 350, 1000, 2, true, 254, $4)`,
    [
      fixture.values.vault,
      fixture.values.owner,
      fixture.values.authority,
      '2024-01-04T00:00:00.000Z',
    ],
  );

  await pool.query(
    `INSERT INTO "${fixture.tables.accountHistory}"
      (pubkey, slot, owner, lamports, source_kind, source_ref, signature, captured_at, authority, total_deposited, max_capacity, deposit_count, is_active, bump)
     VALUES
      ($1, 100, $2, 3500000, 'transaction', 'transaction:' || $3, $3, $4, $5, 100, 1000, 1, true, 254),
      ($1, 101, $2, 4000000, 'transaction', 'transaction:' || $6, $6, $7, $5, 350, 1000, 2, true, 254)`,
    [
      fixture.values.vault,
      fixture.values.owner,
      fixture.values.sigDepositA,
      '2024-01-02T00:00:00.000Z',
      fixture.values.authority,
      fixture.values.sigDepositB,
      '2024-01-03T00:00:00.000Z',
    ],
  );
}

async function fetchJson(baseUrl, route, headers = {}) {
  const response = await fetch(`${baseUrl}${route}`, { headers });
  const body = await response.json();
  return { response, body };
}

async function fetchText(baseUrl, route, headers = {}) {
  const response = await fetch(`${baseUrl}${route}`, { headers });
  const body = await response.text();
  return { response, body };
}

function authHeaders() {
  return {
    Authorization: `Bearer ${authToken}`,
  };
}

async function verifyBaseEndpoints(baseUrl) {
  logStep('Validating smoke endpoints and dynamic API discovery');

  const health = await fetchJson(baseUrl, '/health');
  assert(health.response.status === 200, 'Expected /health to return 200');
  assert(health.body.status === 'ok', 'Expected /health status=ok');

  const ready = await fetchJson(baseUrl, '/ready');
  assert(ready.response.status === 200, 'Expected /ready to return 200');
  assert(ready.body.status === 'ready', 'Expected /ready status=ready');

  const unauthorizedStats = await fetchJson(baseUrl, '/api/stats');
  assert(unauthorizedStats.response.status === 401, 'Expected protected API route to require auth');

  const metricsResponse = await fetchText(baseUrl, '/metrics', authHeaders());
  assert(metricsResponse.response.status === 200, 'Expected /metrics to return 200');
  assert(
    metricsResponse.body.includes('solana_indexer_lifecycle_state{state="api_ready"} 1'),
    'Expected metrics output to expose api_ready lifecycle state',
  );

  const program = await fetchJson(baseUrl, '/api/program', authHeaders());
  assert(program.response.status === 200, 'Expected /api/program to return 200');
  assert(program.body.name === fixture.programName, 'Expected test IDL program name');
  assert(program.body.instructions.length === 3, 'Expected 3 instructions from test fixture');
  assert(program.body.accounts.length === 1, 'Expected 1 account type from test fixture');
  assert(program.body.events.length === 1, 'Expected 1 event type from test fixture');

  const routes = await fetchJson(baseUrl, '/api', authHeaders());
  assert(routes.response.status === 200, 'Expected /api to return 200');
  assert(routes.body.endpoints.includes('GET /api/instructions/deposit'), 'Expected deposit route in discovery');
  assert(routes.body.endpoints.includes('GET /api/events/deposit_event'), 'Expected event route in discovery');
  assert(routes.body.endpoints.includes('GET /api/accounts/vault/:pubkey/history'), 'Expected account history route in discovery');
}

async function verifySeededApi(baseUrl) {
  logStep('Validating seeded stats, filtering, aggregation, and account history endpoints');

  const stats = await fetchJson(baseUrl, '/api/stats', authHeaders());
  assert(stats.response.status === 200, 'Expected /api/stats to return 200');
  assert(stats.body.totalTransactions === 4, 'Expected seeded totalTransactions=4');
  assert(stats.body.successfulTransactions === 3, 'Expected seeded successfulTransactions=3');
  assert(stats.body.failedTransactions === 1, 'Expected seeded failedTransactions=1');
  assert(stats.body.instructionCounts.deposit === 2, 'Expected seeded deposit instruction count=2');
  assert(stats.body.instructionCounts.withdraw === 1, 'Expected seeded withdraw instruction count=1');
  assert(stats.body.eventCounts.DepositEvent === 2, 'Expected seeded event count=2');
  assert(stats.body.accountCounts.Vault === 1, 'Expected seeded account count=1');
  assert(stats.body.indexer.lastProcessedSignature === fixture.values.sigWithdraw, 'Expected checkpoint signature in /api/stats');
  assert(stats.body.indexer.lastProcessedSlot === 102, 'Expected checkpoint slot in /api/stats');

  const transactions = await fetchJson(
    baseUrl,
    '/api/transactions?success=true&slot_from=100&slot_to=101&limit=10&offset=0',
    authHeaders(),
  );
  assert(transactions.response.status === 200, 'Expected filtered transaction query to return 200');
  assert(transactions.body.pagination.total === 2, 'Expected two successful transactions in the slot range');
  assert(transactions.body.data.length === 2, 'Expected two transaction rows in filtered query');

  const depositRows = await fetchJson(
    baseUrl,
    `/api/instructions/deposit?acc_depositor=${fixture.values.depositorB}&amount_from=200&limit=10`,
    authHeaders(),
  );
  assert(depositRows.response.status === 200, 'Expected filtered instruction query to return 200');
  assert(depositRows.body.pagination.total === 1, 'Expected one filtered deposit row');
  assert(depositRows.body.data[0].signature === fixture.values.sigDepositB, 'Expected deposit filter to return sigDepositB');

  const depositAggregate = await fetchJson(
    baseUrl,
    '/api/instructions/deposit/aggregate?group_by=acc_depositor',
    authHeaders(),
  );
  assert(depositAggregate.response.status === 200, 'Expected instruction aggregation to return 200');
  assert(depositAggregate.body.aggregation.length === 2, 'Expected two depositor groups in aggregation');

  const eventRows = await fetchJson(
    baseUrl,
    '/api/events/deposit_event?amount_from=200&limit=10',
    authHeaders(),
  );
  assert(eventRows.response.status === 200, 'Expected filtered event query to return 200');
  assert(eventRows.body.pagination.total === 1, 'Expected one filtered event row');
  assert(eventRows.body.data[0].signature === fixture.values.sigDepositB, 'Expected event filter to return sigDepositB');

  const eventAggregate = await fetchJson(
    baseUrl,
    '/api/events/deposit_event/aggregate?interval=day&from=2024-01-01&to=2024-01-04',
    authHeaders(),
  );
  assert(eventAggregate.response.status === 200, 'Expected event aggregation to return 200');
  assert(eventAggregate.body.aggregation.length === 2, 'Expected two daily event aggregation buckets');

  const accountRows = await fetchJson(
    baseUrl,
    `/api/accounts/vault?owner=${fixture.values.owner}&limit=10`,
    authHeaders(),
  );
  assert(accountRows.response.status === 200, 'Expected account query to return 200');
  assert(accountRows.body.pagination.total === 1, 'Expected one latest account row');
  assert(accountRows.body.data[0].pubkey === fixture.values.vault, 'Expected seeded latest account row');

  const accountHistory = await fetchJson(
    baseUrl,
    `/api/accounts/vault/${fixture.values.vault}/history?slot_from=100&limit=10`,
    authHeaders(),
  );
  assert(accountHistory.response.status === 200, 'Expected account history query to return 200');
  assert(accountHistory.body.pagination.total === 2, 'Expected two account history rows');
  assert(accountHistory.body.history.length === 2, 'Expected two returned history rows');

  const invalidInterval = await fetchJson(
    baseUrl,
    '/api/instructions/deposit/aggregate?interval=minute',
    authHeaders(),
  );
  assert(invalidInterval.response.status === 400, 'Expected invalid aggregation interval to return 400');

  const invalidAccountFilter = await fetchJson(
    baseUrl,
    '/api/accounts/vault?unknown=value',
    authHeaders(),
  );
  assert(invalidAccountFilter.response.status === 400, 'Expected invalid account filter to return 400');
}

module.exports = {
  assert,
  authHeaders,
  authToken,
  createPool,
  createValidationEnv,
  dummyProgramId,
  extractJsonLogLine,
  fixture,
  logStep,
  repoRoot,
  runCommand,
  seedValidationData,
  startProcess,
  stopProcess,
  verifyBaseEndpoints,
  verifySchema,
  verifySeededApi,
  verifyStructuredLogs,
  waitForHttp,
  waitForPostgres,
};
