# Solana Universal Indexer

Index any Anchor program on Solana — just point it at an IDL and go.

This thing reads your Anchor IDL at startup, spins up PostgreSQL tables to match, and starts decoding transactions, events, and account state. No manual schema work, no per-program customization. Swap the IDL and program ID, restart, and you're indexing a completely different program.

Built for the [Superteam Ukraine bounty](https://superteam.fun/earn/listing/build-universal-solana-indexer-middle/).

## Why

Most Solana indexers are either too generic (raw transaction dumps) or too specific (hardcoded for one protocol). This sits in the middle: it understands Anchor IDL structure and uses it to create a proper relational schema automatically, while staying program-agnostic.

## How it works

1. You provide an Anchor IDL + program ID
2. On startup, the indexer parses the IDL and creates PostgreSQL tables for each instruction, event, and account type
3. It fetches transactions via RPC, decodes them using Anchor's coder libraries, and persists everything atomically
4. A REST API spins up with auto-generated endpoints for querying, filtering, and aggregating the indexed data

Three indexing modes:
- **`realtime`** — WebSocket subscription with cold-start gap filling
- **`batch`** — historical backfill by slot range or explicit signature list
- **`backfill_then_realtime`** — does both sequentially

## Quick start

```bash
cp .env.example .env
cp your-program-idl.json idl.json
docker compose up --build
```

API is on `http://localhost:3000`. Check `GET /api` for all available endpoints.

## What gets indexed

For a program called `my_program`, you'll get these tables:

| Table | What's in it |
|-------|-------------|
| `_transactions` | Every indexed transaction (signature, slot, block time, success) |
| `my_program_ix_<n>` | One table per instruction — args + account keys as columns |
| `my_program_evt_<n>` | One table per Anchor event |
| `my_program_acc_<n>` | Latest decoded state of each program account |
| `my_program_acc_<n>_history` | Append-only history for auditing |

## API

```
GET /api                              # list all endpoints
GET /api/program                      # loaded IDL metadata
GET /api/stats                        # global stats
GET /api/transactions?success=true    # filter transactions
GET /api/instructions/deposit?acc_user=<pubkey>&amount_from=1000
GET /api/instructions/deposit/aggregate?interval=day
GET /api/events/deposit_event?limit=50
GET /api/accounts/vault/<pubkey>
GET /api/accounts/vault/<pubkey>/history
GET /health                           # liveness
GET /ready                            # readiness
GET /metrics                          # prometheus-style metrics
```

## Reliability

- **Atomic writes** — each Solana tx persisted in a single PostgreSQL transaction
- **Checkpointing** — crash-safe batch and realtime modes
- **RPC retries** — exponential backoff with jitter
- **Schema evolution** — new IDL fields add columns automatically
- **Graceful shutdown** — drains in-flight work, then closes connections

## Configuration

| Variable | Default | What it does |
|----------|---------|-------------|
| `SOLANA_RPC_URL` | mainnet public | Your RPC endpoint |
| `PROGRAM_ID` | *required* | Program to index |
| `IDL_PATH` | `./idl.json` | Anchor IDL file |
| `INDEXER_MODE` | `realtime` | `realtime`, `batch`, or `backfill_then_realtime` |
| `DATABASE_URL` | local postgres | PostgreSQL connection string |
| `API_PORT` | `3000` | API port |

Full list in `.env.example`.

## Project structure

```
src/
  config/       — env parsing (Zod)
  idl/          — IDL loading and normalization
  database/     — schema generation, repository, queries
  decoder/      — instruction/event/account decoding via Anchor coders
  indexer/      — RPC client, batch runner, realtime subscriber, processor
  api/          — Express REST API with dynamic route registration
  utils/        — retry logic, naming helpers
  index.ts      — entry point
```

## Testing

```bash
npm ci
npm test
```

Tests cover IDL parsing, schema mapping, retry behavior, atomic transaction persistence, deduplication, cold-start handling, API validation/auth/rate-limiting, and batch checkpoint resume.

## Known limitations

- **RPC-based, not Geyser**: Simpler to deploy but slower for high-throughput programs. Geyser integration is on the roadmap.
- **One table per instruction type**: Clean and inspectable, but many tables for large IDLs.
- **JSONB for nested types**: Flexible but not ideal for deep field queries.

## Roadmap

See [`docs/ROADMAP.md`](docs/ROADMAP.md) for upcoming features including Geyser/Yellowstone integration, multi-program indexing, and GraphQL API.

## Demo

See [`docs/DEMO.md`](docs/DEMO.md) for running the indexer against a real Solana program.

## License

MIT
