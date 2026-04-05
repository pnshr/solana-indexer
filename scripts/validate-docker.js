const {
  assert,
  createPool,
  createValidationEnv,
  logStep,
  repoRoot,
  runCommand,
  seedValidationData,
  verifyBaseEndpoints,
  verifySchema,
  verifySeededApi,
  verifyStructuredLogs,
  waitForHttp,
  waitForPostgres,
} = require('./lib/validation');

const projectName = 'solana-indexer-docker-validation';
const apiPort = 3101;
const postgresPort = 55433;
const databaseUrl = `postgresql://indexer:indexer@127.0.0.1:${postgresPort}/solana_indexer`;

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

async function main() {
  let pool;

  try {
    const composeEnv = createValidationEnv({
      IDL_PATH: '/app/test-idl.json',
      API_PORT: String(apiPort),
      POSTGRES_PORT: String(postgresPort),
    });

    logStep('Rendering Docker Compose config');
    await runCommand(
      'docker',
      ['compose', '-p', projectName, 'config'],
      {
        cwd: repoRoot,
        env: composeEnv,
      },
    );

    logStep('Starting the full Docker Compose stack in validation-only mode');
    await cleanup();
    await runCommand(
      'docker',
      ['compose', '-p', projectName, 'up', '-d', '--build'],
      {
        cwd: repoRoot,
        env: composeEnv,
        inheritStdout: true,
        inheritStderr: true,
      },
    );

    const baseUrl = `http://127.0.0.1:${apiPort}`;
    await waitForHttp(`${baseUrl}/health`, { timeoutMs: 60000 });

    const logs = await runCommand(
      'docker',
      ['compose', '-p', projectName, 'logs', '--no-color', 'indexer'],
      {
        cwd: repoRoot,
        env: composeEnv,
      },
    );
    verifyStructuredLogs(logs.stdout.split(/\r?\n/).filter(Boolean));

    pool = createPool(databaseUrl);
    await waitForPostgres(pool);

    await verifySchema(pool);
    await verifyBaseEndpoints(baseUrl);
    await seedValidationData(pool);
    await verifySeededApi(baseUrl);

    logStep('Stopping the indexer container to verify graceful SIGTERM shutdown');
    await runCommand(
      'docker',
      ['compose', '-p', projectName, 'stop', 'indexer'],
      {
        cwd: repoRoot,
        env: composeEnv,
        inheritStdout: true,
        inheritStderr: true,
      },
    );

    const shutdownLogs = await runCommand(
      'docker',
      ['compose', '-p', projectName, 'logs', '--no-color', 'indexer'],
      {
        cwd: repoRoot,
        env: composeEnv,
      },
    );
    assert(
      shutdownLogs.stdout.includes('Graceful shutdown initiated')
        && shutdownLogs.stdout.includes('Shutdown complete'),
      'Expected Docker logs to contain graceful shutdown markers',
    );

    console.log('\nDocker validation succeeded.');
  } finally {
    await cleanup(pool);
  }
}

main().catch((error) => {
  console.error('\nDocker validation failed.');
  console.error(error.message);
  process.exit(1);
});
