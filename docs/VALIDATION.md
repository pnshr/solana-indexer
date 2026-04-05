# Validation

This repository ships with three validation layers so reviewers can choose speed versus depth.

## 1. Fast validation

```bash
npm run validate:fast
```

What it proves:

- TypeScript builds successfully
- Jest suite passes
- batch signature-list logic is covered
- slot-range collection logic is covered
- realtime cold-start queueing is covered
- retry and backoff behavior is covered
- API validation behavior is covered
- config validation is covered

What it does not prove:

- live Solana RPC behavior
- real PostgreSQL schema creation
- Docker Compose startup

## 2. Local validation with a real database

```bash
npm run validate:local
```

What it does:

1. Starts PostgreSQL via `docker compose`
2. Builds the app locally
3. Boots the service locally with `INDEXER_DISABLE_RUN=true`
4. Verifies `/health`, `/ready`, `/metrics`, `/api/program`, and `/api`
5. Verifies generated PostgreSQL tables and selected field type mappings
6. Seeds deterministic fixture rows into generated tables
7. Verifies stats, multi-filter API queries, aggregations, account history, and invalid input handling
8. On Unix-like systems, sends `SIGINT` and checks graceful shutdown
9. On Windows, confirms clean stop responsiveness and defers graceful-shutdown proof to Docker `SIGTERM` validation

Why `INDEXER_DISABLE_RUN=true` exists:

- it makes the validation deterministic
- it proves startup, schema generation, and API wiring without requiring a live Solana RPC
- it is a validation mode only, not a substitute for live indexing

What it proves strongly:

- automatic schema generation from the sample Anchor IDL
- real PostgreSQL table creation
- real API behavior against real database state
- structured logging
- graceful shutdown on Unix-like local runs
- clean local stop responsiveness on Windows

What it does not prove:

- actual live chain ingestion

## 2.5. Smoke check against an already running service

```bash
npm run validate:smoke
```

Optional environment variables:

```bash
VALIDATION_BASE_URL=http://127.0.0.1:3000
VALIDATION_API_TOKEN=your-token-if-api-auth-is-enabled
```

What it proves:

- the currently running service responds on `/health` and `/ready`
- the protected API surface is reachable when auth is configured correctly
- `/metrics`, `/api`, `/api/program`, and `/api/stats` are wired and returning live responses

What it does not prove:

- schema generation from scratch
- database bootstrapping
- cold-start or live indexing behavior

## 3. Full Docker Compose validation

```bash
npm run validate:docker
```

What it does:

1. Renders `docker compose config`
2. Starts PostgreSQL plus the indexer container
3. Boots the container in `INDEXER_DISABLE_RUN=true` mode
4. Verifies container health and API endpoints
5. Verifies generated schema against PostgreSQL
6. Seeds deterministic rows and re-checks API behavior
7. Stops the container and verifies graceful `SIGTERM` shutdown markers in the logs

What it proves strongly:

- Dockerfile plus docker-compose startup path
- env-based configuration through compose
- structured logs from the running container
- API reachability and schema generation inside the containerized stack
- graceful container shutdown

What it does not prove:

- live indexing against Solana mainnet or devnet

## Optional manual live validation

To validate real indexing behavior, provide:

- a real RPC URL
- a real websocket URL
- a real Anchor IDL
- the matching `PROGRAM_ID`

Recommended mode:

```env
INDEXER_MODE=backfill_then_realtime
INDEXER_DISABLE_RUN=false
```

Then run:

```bash
npm run dev
```

Suggested reviewer checks:

- watch logs for cold start and transition to realtime
- open `/api/stats`
- query one instruction endpoint
- query one account endpoint
- restart the process and confirm checkpoint-based continuation

## Honest boundary

The automated scripts in this document are designed to prove the repository's core mechanics without relying on a flaky public RPC endpoint.

They strongly prove:

- schema generation
- API behavior
- database write and query assumptions
- Docker and local boot reproducibility
- deterministic container shutdown

They do not fully prove:

- Solana RPC correctness under every provider
- long-running mainnet stability
- reorg behavior
- destructive IDL migration handling

## CI proof

The repository also ships with [`.github/workflows/validation.yml`](../.github/workflows/validation.yml):

- `validate:fast` runs automatically on push and pull request
- `validate:docker` is available as a manual workflow-dispatch path for a heavier containerized check

That workflow does not replace local review, but it does mean the repo can continuously prove its fast validation path on GitHub.
