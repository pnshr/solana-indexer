# Reviewer Guide

This repository is easiest to review in three steps.

## Happy path

### Step 1: fast confidence

```bash
npm ci
npm run validate:fast
```

This proves the project builds and the deterministic Jest suite passes.

If the service is already running and you only want a one-minute liveness/API check:

```bash
npm run validate:smoke
```

Use `VALIDATION_BASE_URL` and `VALIDATION_API_TOKEN` if your instance is not on the default host or has API auth enabled.

### Step 2: local boot + schema/API proof

```bash
npm run validate:local
```

This is the highest-signal automated validation path for a skeptical reviewer.

It proves:

- the service boots locally
- PostgreSQL schema is generated from the sample Anchor IDL
- `/health`, `/ready`, `/metrics`, `/api/program`, and `/api` work
- seeded data can be queried through the real API
- filtering, aggregation, stats, and account history behave as documented
- on Unix-like systems, the process shuts down cleanly on `SIGINT`
- on Windows, the process stop path is exercised and graceful-shutdown proof is deferred to Docker `SIGTERM` validation

### Step 2.5: real batch write-path proof

```bash
npm run validate:batch
```

This is the strongest deterministic proof of the repository's batch-indexing claim without relying on a live Solana RPC.

It proves:

- the real batch write path persists data into PostgreSQL
- generated instruction/event/account tables receive writes
- checkpoint state is persisted
- an aborted batch resumes from its stored checkpoint
- a successful rerun does not duplicate claimed transactions

### Step 3: full Docker Compose proof

```bash
npm run validate:docker
```

This proves the repository also works through the containerized path.

## What the automated reviewer path intentionally does not require

- a paid Solana RPC
- unstable live-chain network access
- manual database setup
- manual API clicking

## Optional live demo

If you want to see actual Solana indexing instead of deterministic validation:

1. Provide a real `SOLANA_RPC_URL`, `SOLANA_WS_URL`, `PROGRAM_ID`, and `IDL_PATH`
2. Set:

```env
INDEXER_MODE=backfill_then_realtime
INDEXER_DISABLE_RUN=false
```

3. Run:

```bash
npm run dev
```

Suggested live checks:

- observe cold start / gap fill logs
- wait for transition to realtime
- open `/api/stats`
- query an instruction endpoint
- restart the process and confirm checkpoint continuation

## Files worth inspecting

- `docs/VALIDATION.md`
- `.github/workflows/validation.yml`
- `src/database/schema.ts`
- `src/decoder/index.ts`
- `src/indexer/processor.ts`
- `src/indexer/batch.ts`
- `src/indexer/realtime.ts`
- `src/api/index.ts`
