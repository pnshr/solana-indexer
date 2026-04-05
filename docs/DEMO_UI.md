# Demo UI

This repository now includes a minimal reviewer-facing React demo console in [`demo-ui/`](../demo-ui).

It is intentionally small and backend-centric. The goal is to help a technical reviewer quickly confirm that:

- the backend is reachable
- health, readiness, and metrics are wired
- indexer state is visible
- indexed rows can be browsed
- filtering and aggregation can be exercised
- generated program metadata is discoverable

## Quick start

Install backend dependencies:

```bash
npm ci
```

Install demo UI dependencies:

```bash
npm --prefix demo-ui ci
```

Run backend and UI together:

```bash
npm run demo:dev
```

Open:

```text
http://127.0.0.1:5173
```

## Backend alternatives

If you want to run the backend another way, the demo UI still works as long as the API is reachable:

- local backend: `npm run dev`
- Docker backend: `docker compose up --build`

By default, the Vite dev server proxies API traffic to:

```text
http://127.0.0.1:3000
```

If you need a different backend base URL for a built UI, set:

```bash
VITE_API_BASE_URL=http://127.0.0.1:3000
```

## What reviewers should try first

1. Open the **Status Panel** and press **Refresh**.
   Expected:
   - backend reachable
   - `/health` ok
   - `/ready` ok
   - `/metrics` reachable

2. Open the **Indexer State Panel**.
   Expected:
   - current mode
   - last processed slot or signature if indexing has run
   - transaction counters

3. Use **Data Tables**.
   Expected:
   - transactions table loads
   - one additional resource table loads for accounts, events, or instructions
   - limit/offset changes cause visible differences

4. Use **API Playground**.
   Expected:
   - transaction filtering returns raw JSON
   - stats request returns JSON
   - aggregation request returns JSON if the loaded IDL exposes instructions or events

5. Inspect **Generated Schema / Metadata View**.
   Expected:
   - discovered instruction routes
   - account routes
   - event routes

## Auth

If the backend uses `API_AUTH_TOKEN`, enter it in the token field at the top of the page and click **Apply token**.

The UI stores the token in `localStorage` for convenience during review.

## Build only

```bash
npm run demo:ui:build
```

This produces a Vite production build in:

```text
demo-ui/dist
```
