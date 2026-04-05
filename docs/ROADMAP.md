# Roadmap

## Current: v1.0

- [x] Dynamic schema generation from Anchor IDL
- [x] Instruction, event, and account decoding
- [x] Batch and realtime indexing modes
- [x] REST API with auto-generated endpoints
- [x] Atomic writes with checkpoint resume
- [x] Prometheus metrics and health checks
- [x] Docker deployment

## Next: v1.1 — Geyser/Yellowstone Data Source

The current implementation uses standard RPC methods which work reliably but have throughput limits. Planned:

- Add Yellowstone gRPC as an alternative data source
- Subscribe to program account updates directly from the validator
- Keep RPC as a fallback for environments without Geyser access
- Expected 10-100x throughput improvement for high-activity programs

## v1.2 — Multi-Program Indexing

- Accept multiple IDL + program ID pairs
- Namespace tables by program
- Cross-program transaction correlation

## v1.3 — GraphQL API

- Add GraphQL alongside REST
- Nested queries across instructions/events/accounts
- Subscription support for realtime data push
