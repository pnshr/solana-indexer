const {
  assert,
  createPool,
  createValidationEnv,
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
} = require('./lib/validation');

const projectName = 'solana-indexer-local-validation';
const apiPort = 3100;
const postgresPort = 55432;
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
  let appHandle;

  try {
    logStep('Resetting Docker-backed PostgreSQL for local validation');
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

    logStep('Building the local app');
    await runCommand('npm', ['run', 'build'], {
      cwd: repoRoot,
      inheritStdout: true,
      inheritStderr: true,
    });

    logStep('Booting the local app in validation-only mode');
    appHandle = startProcess(process.execPath, ['dist/index.js'], {
      cwd: repoRoot,
      env: createValidationEnv({
        DATABASE_URL: databaseUrl,
        API_HOST: '127.0.0.1',
        API_PORT: String(apiPort),
      }),
    });

    const baseUrl = `http://127.0.0.1:${apiPort}`;
    try {
      await waitForHttp(`${baseUrl}/health`, { timeoutMs: 45000 });
      verifyStructuredLogs(appHandle.stdoutLines);

      await verifySchema(pool);
      await verifyBaseEndpoints(baseUrl);
      await seedValidationData(pool);
      await verifySeededApi(baseUrl);
    } catch (error) {
      error.appStdoutLines = [...appHandle.stdoutLines];
      error.appStderrLines = [...appHandle.stderrLines];
      throw error;
    }

    const shutdownSignal = process.platform === 'win32' ? 'SIGBREAK' : 'SIGINT';
    logStep(`Stopping the local app with ${shutdownSignal} to verify graceful shutdown`);
    if (process.platform !== 'win32') {
      const shutdownResult = await stopProcess(appHandle, shutdownSignal);
      assert(
        shutdownResult.code === 0 || shutdownResult.signal === shutdownSignal,
        `Expected local app to exit cleanly, received code=${shutdownResult.code} signal=${shutdownResult.signal}`,
      );
      assert(
        shutdownResult.stdoutLines.some((line) => line.includes('Shutdown complete')),
        'Expected local app logs to contain "Shutdown complete"',
      );
    } else {
      await runCommand(
        'taskkill',
        ['/PID', String(appHandle.child.pid), '/T', '/F'],
        { allowFailure: true },
      );
      console.log('Windows note: local validation confirms process stop responsiveness; graceful shutdown is proven via Docker SIGTERM validation.');
    }

    appHandle = null;

    console.log('\nLocal validation succeeded.');
  } finally {
    if (appHandle) {
      await stopProcess(appHandle, 'SIGTERM').catch(() => undefined);
    }
    await cleanup(pool);
  }
}

main().catch((error) => {
  console.error('\nLocal validation failed.');
  console.error(error.message);
  if (error && error.appStdoutLines) {
    console.error('\nApp stdout:');
    console.error(error.appStdoutLines.join('\n'));
  }
  if (error && error.appStderrLines) {
    console.error('\nApp stderr:');
    console.error(error.appStderrLines.join('\n'));
  }
  process.exit(1);
});
