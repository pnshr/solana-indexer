const { logStep, repoRoot, runCommand } = require('./lib/validation');

async function main() {
  logStep('Running TypeScript build');
  await runCommand('npm', ['run', 'build'], {
    cwd: repoRoot,
    inheritStdout: true,
    inheritStderr: true,
  });

  logStep('Running Jest test suite');
  await runCommand('npm', ['test'], {
    cwd: repoRoot,
    inheritStdout: true,
    inheritStderr: true,
  });

  console.log('\nFast validation succeeded.');
}

main().catch((error) => {
  console.error('\nFast validation failed.');
  console.error(error.message);
  process.exit(1);
});
