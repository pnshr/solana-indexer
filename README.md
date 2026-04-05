# Solana Universal Indexer

A production-ready Solana indexer that adapts to any Anchor IDL at runtime.

The project reads an Anchor IDL, generates PostgreSQL tables automatically, decodes instructions and program-owned accounts, supports batch and realtime indexing, and exposes a REST API with filtering, aggregation, and program statistics.

## What It Does

- Generates database tables directly from an Anchor IDL.
- Decodes instructions, Anchor events, and account state with Anchor coders.
- Supports historical backfills by slot range or explicit signature list.
- Supports realtime indexing with cold-start gap filling from the last checkpoint.
- Retries RPC requests with exponential backoff and jitter.
- Validates API filters, pagination, date ranges, and aggregation intervals.
- Supports optional API authentication and per-IP rate limiting.
- Exposes readiness and Prometheus-style metrics endpoints.
- Resumes interrupted batch runs from a stored checkpoint.
- Shuts down gracefully without leaving partially committed transaction writes.
- Exposes dynamic API endpoints for every instruction and account type in the IDL.

## Architecture Overview

The startup flow is:

1. Load and normalize the IDL.
2. Validate environment configuration with Zod.
3. Connect to PostgreSQL.
4. Generate dynamic tables for instructions and accounts.
5. Start the API server.
6. Run either:
   - `batch`
   - `realtime`
   - `backfill_then_realtime`

Operational support tables include:

- `_schema_revisions` for IDL / schema revision audit history
- `_indexer_state` for realtime checkpoints and batch resume checkpoints

Main components:

| Component | File | Responsibility |
| --- | --- | --- |
| Config | `src/config/index.ts` | Environment parsing and validation |
| IDL parser | `src/idl/parser.ts` | Loads and normalizes Anchor IDLs |
| Schema generator | `src/database/schema.ts` | Creates dynamic PostgreSQL tables from IDL fields |
| Decoder | `src/decoder/index.ts` | Decodes instructions, events, and accounts with Anchor coders |
| RPC client | `src/indexer/rpc-client.ts` | Solana RPC wrapper with retries and backoff |
| Processor | `src/indexer/processor.ts` | Atomic transaction persistence, checkpointing, account refresh |
| Batch indexer | `src/indexer/batch.ts` | Historical indexing by slot range or signature list |
| Realtime indexer | `src/indexer/realtime.ts` | Cold start, gap fill, websocket subscription, reconnection |
| Repository | `src/database/repository.ts` | Inserts, queries, aggregations, stats |
| API | `src/api/index.ts` | Dynamic REST API for transactions, instructions, accounts, stats |

## Data Model

For an IDL named `my_program`, the indexer creates:

- `_transactions`: one row per indexed transaction
- `_indexer_state`: checkpoints such as `last_processed_signature`
- `my_program_ix_<instruction_name>`: one table per instruction
- `my_program_evt_<event_name>`: one table per Anchor event
- `my_program_acc_<account_name>`: one table per account type
- `my_program_acc_<account_name>_history`: append-only account history

Instruction tables contain:

- transaction metadata: signature, slot, block time, instruction index
- account columns: `acc_<account_name>`
- argument columns generated from the IDL

Account tables contain:

- `pubkey`, `owner`, `lamports`, `slot`, `last_updated`
- one column per decoded account field

Account history tables contain:

- `pubkey`, `slot`, `owner`, `lamports`
- `source_kind`, `source_ref`, `signature`, `captured_at`
- one column per decoded account field

Nested structs, arrays, and vectors are stored as `JSONB`. Large integers are stored as `NUMERIC`.
Generated SQL identifiers are normalized to PostgreSQL-safe names and deterministically shortened with a hash suffix when needed to avoid identifier-length collisions.

## Reliability Choices

### Atomic transaction writes

Each processed Solana transaction is persisted inside a single PostgreSQL transaction:

- claim transaction signature
- insert decoded instructions
- update indexer checkpoints

If any of those steps fail, the whole write is rolled back. This avoids partially indexed transactions.

### Cold-start gap filling

On startup, realtime mode first loads the last processed signature from `_indexer_state`, fetches missed signatures, processes them in chronological order, and only then switches to websocket mode.

### Batch resume checkpoints

Batch mode persists a batch-specific checkpoint context plus the last completed signature.

- if the same batch job restarts, it resumes after the stored signature
- if the batch context changes, the old checkpoint is discarded automatically
- completed batch runs clear the batch checkpoint keys

### RPC retry strategy

Every RPC call goes through `withRetry()`:

- exponential backoff
- capped max delay
- random jitter to avoid thundering herd behavior

### Observability

The service exposes:

- `/health` for liveness
- `/ready` for readiness
- `/metrics` for Prometheus-style counters and gauges

Collected metrics include API traffic, request latency, retries, retry exhaustion, reconnect attempts, batch resumes, current slot, last processed slot, realtime lag, uptime, and memory usage.

### Graceful shutdown

On `SIGINT` or `SIGTERM`, the app:

- stops realtime subscriptions
- waits for in-flight processing to drain
- closes the HTTP server
- closes the database pool

### Account freshness

The indexer supports account decoding in two ways:

- full snapshot of all program accounts during dedicated account indexing
- post-transaction refresh of touched program-owned accounts after successful transactions

This keeps account tables current in both batch and realtime flows while also appending account history rows.

### Event indexing

Anchor events are parsed from transaction log messages using Anchor's `EventParser`.

- every event type in the IDL gets its own table
- event rows are stored atomically with transaction and instruction rows
- event endpoints are exposed dynamically in the API

### Schema drift handling

The schema generator is additive for existing tables:

- if a table does not exist, it is created
- if the same IDL evolves and adds new fields, missing columns are added automatically
- if an existing table is malformed or destructive schema changes are required, startup fails fast instead of silently running against a broken schema
- every applied IDL revision is recorded in `_schema_revisions`

## Quick Start

### Prerequisites

- Docker
- Docker Compose
- a Solana RPC endpoint
- an Anchor IDL file
- the program ID you want to index

### 1. Configure the project

```bash
cp .env.example .env
```

Edit `.env`:

```env
SOLANA_RPC_URL=https://api.mainnet-beta.solana.com
SOLANA_WS_URL=wss://api.mainnet-beta.solana.com
PROGRAM_ID=YourProgramIdHere
IDL_PATH=./idl.json
INDEXER_MODE=backfill_then_realtime
```

For production throughput, use a dedicated Solana RPC endpoint. Public endpoints and free plans may rate-limit batch RPC calls, in which case the indexer falls back to slower per-signature reads.

### 2. Place the IDL

Copy your IDL JSON to `./idl.json`.

For a quick local smoke setup you can start from the sample file:

```bash
cp test-idl.json idl.json
```

### 3. Start everything

```bash
docker compose up --build
```

The stack starts:

- PostgreSQL 16
- the indexer
- the REST API on port `3000`

## Local Development

Install dependencies:

```bash
npm ci
```

Run in development mode:

```bash
npm run dev
```

Build:

```bash
npm run build
```

Run tests:

```bash
npm test
```

Validation entry points:

```bash
npm run validate:fast
npm run validate:smoke
npm run validate:batch
npm run validate:local
npm run validate:docker
```

If the service is already running, `npm run validate:smoke` checks `/health`, `/ready`, `/metrics`, `/api/program`, `/api`, and `/api/stats` against the live instance. Use `VALIDATION_BASE_URL` to point it at a non-default host or port, and `VALIDATION_API_TOKEN` if the API is protected.

Reviewer-facing docs:

- [`docs/VALIDATION.md`](docs/VALIDATION.md)
- [`docs/REVIEWER_GUIDE.md`](docs/REVIEWER_GUIDE.md)

GitHub Actions:

- [`.github/workflows/validation.yml`](.github/workflows/validation.yml) runs `validate:fast` on pushes and pull requests, and exposes a manual `validate:docker` workflow-dispatch path for the heavier containerized proof.
- The same manual workflow-dispatch path also runs `validate:batch`, which exercises the real batch write path against PostgreSQL with a deterministic fake RPC boundary.

## Indexing Modes

### `realtime`

Starts with cold-start recovery and then subscribes to new program logs.

### `batch`

Processes historical data only.

Use one of:

- `BATCH_SIGNATURES=sig1,sig2,sig3`
- `BATCH_START_SLOT=...` and optionally `BATCH_END_SLOT=...`

### `backfill_then_realtime`

Runs a historical backfill first and then switches to realtime mode.

## API

### Service discovery

```http
GET /api
```

Returns all dynamically registered endpoints for the loaded IDL.

### Health

```http
GET /health
```

### Readiness

```http
GET /ready
```

Returns `200` when PostgreSQL is reachable and the service lifecycle is ready. In realtime modes it also checks that lag is within an acceptable range.

### Metrics

```http
GET /metrics
```

Returns Prometheus-style metrics. If `API_AUTH_TOKEN` is configured, send it as `Authorization: Bearer <token>` or `x-api-key`.

### Program metadata

```http
GET /api/program
```

Returns the loaded program name, version, instructions, accounts, and events.

### Global stats

```http
GET /api/stats
```

Example response:

```json
{
  "totalTransactions": 15234,
  "successfulTransactions": 14890,
  "failedTransactions": 344,
  "instructionCounts": {
    "initialize": 12,
    "deposit": 9841,
    "withdraw": 5381
  },
  "eventCounts": {
    "DepositEvent": 9841
  },
  "accountCounts": {
    "Vault": 12
  },
  "indexer": {
    "lastProcessedSignature": "5K8F...",
    "lastProcessedSlot": 284719234,
    "mode": "backfill_then_realtime"
  }
}
```

### Transaction queries

```http
GET /api/transactions?success=true&slot_from=280000000&slot_to=281000000&limit=20&offset=0
```

Supported filters:

- `success=true|false`
- `slot_from`
- `slot_to`
- `from`
- `to`
- `limit`
- `offset`

### Instruction queries

For an instruction named `deposit`:

```http
GET /api/instructions/deposit?acc_user=<pubkey>&amount_from=1000&slot_to=284800000&limit=10
```

Supported patterns:

- exact match: `?field=value`
- range filters: `?field_from=x&field_to=y`
- multiple filters at once
- pagination: `limit`, `offset`
- ordering: `order_by`, `order`

### Aggregation

Count calls by time interval:

```http
GET /api/instructions/deposit/aggregate?interval=day&from=2024-01-01&to=2024-12-31
```

Count calls by field:

```http
GET /api/instructions/deposit/aggregate?group_by=acc_user
```

Invalid filter columns, invalid pagination values, invalid dates, and unsupported aggregation intervals return `400 Bad Request` instead of surfacing raw database errors.

### Event queries

For an event named `deposit_event`:

```http
GET /api/events/deposit_event?amount_from=1000&slot_to=284800000&limit=10
```

Event aggregations follow the same pattern as instructions:

```http
GET /api/events/deposit_event/aggregate?interval=day
```

### Account queries

List decoded account rows:

```http
GET /api/accounts/vault?owner=<program_owner>&limit=50
```

Fetch one decoded account:

```http
GET /api/accounts/vault/<pubkey>
```

Fetch account history:

```http
GET /api/accounts/vault/<pubkey>/history?slot_from=280000000&limit=50
```

## Environment Variables

| Variable | Default | Description |
| --- | --- | --- |
| `SOLANA_RPC_URL` | `https://api.mainnet-beta.solana.com` | Solana JSON-RPC endpoint |
| `SOLANA_WS_URL` | `wss://api.mainnet-beta.solana.com` | Solana websocket endpoint |
| `PROGRAM_ID` | required | Program address to index |
| `IDL_PATH` | `./idl.json` | Path to the Anchor IDL |
| `DATABASE_URL` | local Postgres URL | PostgreSQL connection string |
| `API_PORT` | `3000` | API port |
| `API_HOST` | `0.0.0.0` | API bind host |
| `API_AUTH_TOKEN` | unset | Optional Bearer token / `x-api-key` for `/api/*` and `/metrics` |
| `API_RATE_LIMIT_WINDOW_MS` | `60000` | Rate-limit window in milliseconds |
| `API_RATE_LIMIT_MAX_REQUESTS` | `120` | Max requests per IP within the rate-limit window |
| `ENABLE_METRICS` | `true` | Expose the `/metrics` endpoint |
| `INDEXER_MODE` | `realtime` | `realtime`, `batch`, or `backfill_then_realtime` |
| `BATCH_START_SLOT` | unset | Inclusive batch start slot |
| `BATCH_END_SLOT` | unset | Inclusive batch end slot |
| `BATCH_SIGNATURES` | unset | Comma-separated signature list |
| `BATCH_SIZE` | `100` | Batch processing chunk size |
| `BATCH_RESUME` | `true` | Resume interrupted batch runs from stored checkpoint |
| `INDEXER_DISABLE_RUN` | `false` | Validation-only mode: boot API and generate schema without running batch/realtime workers |
| `REALTIME_HEALTHCHECK_INTERVAL_MS` | `30000` | Realtime health and lag-check interval |
| `REALTIME_RECONNECT_DELAY_MS` | `5000` | Delay between realtime reconnect attempts |
| `REALTIME_LAG_WARNING_SLOTS` | `150` | Warn when realtime lag exceeds this slot distance |
| `MAX_RETRIES` | `5` | RPC retry count |
| `INITIAL_RETRY_DELAY_MS` | `500` | Initial retry delay |
| `MAX_RETRY_DELAY_MS` | `30000` | Max retry delay |
| `LOG_LEVEL` | `info` | `debug`, `info`, `warn`, `error` |

## Key Design Decisions And Trade-offs

### One table per instruction and account type

Why:

- dynamic and easy to inspect
- works for arbitrary Anchor programs
- avoids manual schema maintenance

Trade-off:

- many tables for large IDLs

### Stable SQL naming

Why:

- prevents PostgreSQL identifier overflow
- avoids silent truncation collisions on long Anchor names

Trade-off:

- extremely long generated identifiers may include a hash suffix instead of a fully readable name

### `JSONB` for nested structures

Why:

- supports arbitrary nested IDL types
- avoids flattening complexity

Trade-off:

- nested-field filtering is less convenient than fully flattened SQL columns

### `NUMERIC` for large integer types

Why:

- safe for `u64`, `u128`, and larger values

Trade-off:

- less convenient than plain `BIGINT` for arithmetic-heavy analytics

### Account tables store both latest state and append-only history

Why:

- latest-state queries stay simple and fast
- history remains available for auditing and debugging

Trade-off:

- storage use is higher than a latest-only model
- on upgrade from an older database, only the current latest rows can be bootstrapped into history retroactively

### Additive schema evolution only

Why:

- safe to auto-apply new columns from evolved IDLs
- avoids hidden destructive migrations at startup

Trade-off:

- type changes, dropped fields, and table reshapes still require manual migration planning

### Built-in API protection is pragmatic, not a full gateway replacement

Why:

- protects production endpoints immediately with a shared secret
- adds a basic rate limiter without extra infrastructure

Trade-off:

- the rate limiter is process-local; large multi-instance deployments should move that concern to a shared reverse proxy or API gateway

## Test Coverage

Current tests cover:

- IDL loading and normalization
- schema type mapping
- retry behavior
- transaction processor atomic persistence path with event persistence
- transaction deduplication claim path
- realtime cold-start race handling
- RPC fallback behavior for both plan-limited and generic batch failures
- batch resume checkpoint handling
- API validation for instruction, event, account, and account-history filters
- API auth, readiness, metrics, and rate limiting behavior

## Project Structure

```text
src/
  api/
  config/
  database/
  decoder/
  idl/
  indexer/
  utils/
  index.ts
```

## Notes For Submission

If you are using this repository for a hackathon or bounty submission, add:

- your public GitHub repository URL
- your Twitter/X thread describing the build process and trade-offs

A ready-to-edit English thread draft is included in `TWITTER_THREAD.md`.

## License

MIT
