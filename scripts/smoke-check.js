const defaultBaseUrl = process.env.VALIDATION_BASE_URL || 'http://127.0.0.1:3000';
const authToken = process.env.VALIDATION_API_TOKEN || process.env.API_AUTH_TOKEN || '';

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function authHeaders() {
  return authToken
    ? { Authorization: `Bearer ${authToken}` }
    : {};
}

async function fetchJson(path, headers = {}) {
  const response = await fetch(`${defaultBaseUrl}${path}`, { headers });
  const contentType = response.headers.get('content-type') || '';
  const body = contentType.includes('application/json')
    ? await response.json()
    : await response.text();
  return { response, body };
}

async function expectOkJson(path, headers = {}) {
  const { response, body } = await fetchJson(path, headers);
  assert(response.ok, `Expected ${path} to return 200, received ${response.status}`);
  assert(typeof body === 'object' && body !== null, `Expected ${path} to return JSON`);
  return body;
}

async function main() {
  console.log(`Running smoke check against ${defaultBaseUrl}`);

  const health = await expectOkJson('/health');
  assert(health.status === 'ok', 'Expected /health status=ok');

  const ready = await expectOkJson('/ready');
  assert(ready.status === 'ready', 'Expected /ready status=ready');

  const program = await fetchJson('/api/program', authHeaders());
  if (program.response.status === 401 && !authToken) {
    throw new Error(
      'The API is protected. Re-run with VALIDATION_API_TOKEN or API_AUTH_TOKEN set so /api/program can be checked.',
    );
  }
  assert(program.response.ok, `Expected /api/program to return 200, received ${program.response.status}`);

  const stats = await fetchJson('/api/stats', authHeaders());
  assert(stats.response.ok, `Expected /api/stats to return 200, received ${stats.response.status}`);

  const discovery = await fetchJson('/api', authHeaders());
  assert(discovery.response.ok, `Expected /api to return 200, received ${discovery.response.status}`);

  const metrics = await fetch(`${defaultBaseUrl}/metrics`, { headers: authHeaders() });
  if (metrics.status === 401 && !authToken) {
    throw new Error(
      'The metrics endpoint is protected. Re-run with VALIDATION_API_TOKEN or API_AUTH_TOKEN set so /metrics can be checked.',
    );
  }
  assert(metrics.ok, `Expected /metrics to return 200, received ${metrics.status}`);
  const metricsText = await metrics.text();
  assert(
    metricsText.includes('solana_indexer_lifecycle_state'),
    'Expected /metrics to include solana_indexer_lifecycle_state',
  );

  const endpointCount = Array.isArray(discovery.body?.endpoints)
    ? discovery.body.endpoints.length
    : undefined;
  const programName = typeof program.body?.name === 'string'
    ? program.body.name
    : 'unknown';
  const totalTransactions = typeof stats.body?.totalTransactions === 'number'
    ? stats.body.totalTransactions
    : 'unknown';

  console.log('Smoke check summary:');
  console.log(`- health: ${health.status}`);
  console.log(`- readiness: ${ready.status}`);
  console.log(`- program: ${programName}`);
  console.log(`- totalTransactions: ${totalTransactions}`);
  if (endpointCount !== undefined) {
    console.log(`- discovered endpoints: ${endpointCount}`);
  }

  console.log('\nSmoke check succeeded.');
}

main().catch((error) => {
  console.error('\nSmoke check failed.');
  console.error(error.message);
  process.exit(1);
});
