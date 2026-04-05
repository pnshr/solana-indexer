# Live Demo: Indexing a Real Solana Program

This guide walks through indexing a real Anchor program on Solana mainnet.

## Prerequisites

- Docker + Docker Compose
- A Solana RPC endpoint (Helius free tier, QuickNode, or similar)

## 1. Configure

```bash
cp .env.example .env
```

Edit `.env` with your RPC URL and the program you want to index:

```env
SOLANA_RPC_URL=https://api.mainnet-beta.solana.com
PROGRAM_ID=<your_program_id>
IDL_PATH=./idl.json
INDEXER_MODE=batch
BATCH_START_SLOT=280000000
BATCH_END_SLOT=280000500
BATCH_SIZE=25
LOG_LEVEL=info
```

Small slot range (500 slots) keeps the demo quick.

## 2. Place the IDL

```bash
# Fetch from chain
anchor idl fetch <PROGRAM_ID> --provider.cluster mainnet > idl.json

# Or use the bundled test IDL for a quick check
cp test-idl.json idl.json
```

## 3. Start

```bash
docker compose up --build
```

Watch the logs. You should see IDL loading, table generation, and transaction decoding.

## 4. Explore the API

```bash
curl http://localhost:3000/api/stats | jq        # what was indexed
curl http://localhost:3000/api | jq               # all endpoints
curl http://localhost:3000/api/program | jq        # IDL metadata
curl http://localhost:3000/api/transactions | jq   # transactions
```

## 5. Switch to a different program

Swap the IDL and program ID, restart, and you're indexing something else. Old tables stay in the database (no conflicts). Use `docker compose down -v` for a clean slate.

## 6. Record evidence

```bash
bash scripts/record-demo.sh
```

This captures API responses, logs, database state, and saves everything to `demo-evidence/`.

## Troubleshooting

**Rate limit errors**: Public RPC endpoints throttle batch requests. Reduce `BATCH_SIZE` to 10, or use a dedicated RPC provider.

**No transactions found**: The program might not have activity in that slot range. Try a more recent range or use `BATCH_SIGNATURES` with known signatures.

**Schema errors**: If the IDL uses unsupported features, startup will fail fast with an error message.
