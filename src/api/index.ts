import express, { Request, Response, NextFunction } from 'express';
import { AnchorIdl } from '../idl/types';
import { config } from '../config';
import { createChildLogger } from '../utils/logger';
import {
  queryInstructions,
  countInstructions,
  aggregateInstructions,
  queryEvents,
  countEvents,
  aggregateEvents,
  queryAccountHistory,
  countAccountHistory,
  getProgramStats,
  getIndexerState,
} from '../database/repository';
import { getDb } from '../database/connection';
import { getAccountTableName } from '../database/schema';
import { sanitizeSqlName } from '../idl/parser';
import { metrics } from '../observability/metrics';

const log = createChildLogger('api');
const VALID_INTERVALS = new Set(['hour', 'day', 'week', 'month']);

class ApiValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ApiValidationError';
  }
}

function normalizeOrder(value?: string): 'asc' | 'desc' {
  return value === 'asc' ? 'asc' : 'desc';
}

function parseLimit(value: unknown): number {
  if (value === undefined) return 50;
  const parsed = Number.parseInt(String(value), 10);
  if (Number.isNaN(parsed) || parsed <= 0) {
    throw new ApiValidationError('Invalid limit');
  }
  return Math.min(parsed, 1000);
}

function parseOffset(value: unknown): number {
  if (value === undefined) return 0;
  const parsed = Number.parseInt(String(value), 10);
  if (Number.isNaN(parsed) || parsed < 0) {
    throw new ApiValidationError('Invalid offset');
  }
  return parsed;
}

function parseNonNegativeInt(value: unknown, field: string): number {
  const parsed = Number.parseInt(String(value), 10);
  if (Number.isNaN(parsed) || parsed < 0) {
    throw new ApiValidationError(`Invalid ${field}`);
  }
  return parsed;
}

function parseDateFilter(value: unknown, field: string): Date {
  const parsed = new Date(String(value));
  if (Number.isNaN(parsed.getTime())) {
    throw new ApiValidationError(`Invalid ${field}`);
  }
  return parsed;
}

function buildInstructionColumnSet(ix: AnchorIdl['instructions'][number]): Set<string> {
  return new Set([
    'id',
    'signature',
    'slot',
    'block_time',
    'instruction_index',
    'indexed_at',
    ...ix.args.map((arg) => sanitizeSqlName(arg.name)),
    ...ix.accounts.map((account) => sanitizeSqlName(`acc_${account.name}`)),
  ]);
}

function buildAccountColumnSet(acc: NonNullable<AnchorIdl['accounts']>[number]): Set<string> {
  return new Set([
    'pubkey',
    'slot',
    'owner',
    'lamports',
    'last_updated',
    ...acc.type.fields.map((field) => sanitizeSqlName(field.name)),
  ]);
}

function buildAccountHistoryColumnSet(acc: NonNullable<AnchorIdl['accounts']>[number]): Set<string> {
  return new Set([
    'id',
    'pubkey',
    'slot',
    'owner',
    'lamports',
    'source_kind',
    'source_ref',
    'signature',
    'captured_at',
    ...acc.type.fields.map((field) => sanitizeSqlName(field.name)),
  ]);
}

function buildEventColumnSet(event: NonNullable<AnchorIdl['events']>[number]): Set<string> {
  return new Set([
    'id',
    'signature',
    'slot',
    'block_time',
    'event_index',
    'indexed_at',
    ...event.fields.map((field) => sanitizeSqlName(field.name)),
  ]);
}

function resolveColumn(rawColumn: string, allowedColumns: Set<string>, label: string): string {
  const column = sanitizeSqlName(rawColumn);
  if (!allowedColumns.has(column)) {
    throw new ApiValidationError(`Unknown ${label}: ${rawColumn}`);
  }
  return column;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function serializeForScript(value: unknown): string {
  return JSON.stringify(value).replace(/</g, '\\u003c');
}

function extractApiToken(req: Request): string | null {
  const authHeader = req.header('authorization');
  if (authHeader?.startsWith('Bearer ')) {
    return authHeader.slice('Bearer '.length).trim();
  }

  return req.header('x-api-key')?.trim() ?? null;
}

export function createApi(idl: AnchorIdl): express.Application {
  const app = express();
  const rateLimitBuckets = new Map<string, { count: number; resetAt: number }>();

  app.use(express.json());

  app.use((req: Request, _res: Response, next: NextFunction) => {
    log.debug({ method: req.method, path: req.path }, 'API request');
    next();
  });

  app.use((req: Request, res: Response, next: NextFunction) => {
    const startedAt = Date.now();
    res.on('finish', () => {
      const route = req.route?.path ? `${req.baseUrl || ''}${req.route.path}` : req.path;
      const labels = {
        method: req.method,
        route,
        status: res.statusCode,
      };
      metrics.incrementCounter('solana_indexer_api_requests_total', 1, labels);
      metrics.incrementCounter('solana_indexer_api_request_duration_ms_sum', Date.now() - startedAt, labels);
      metrics.incrementCounter('solana_indexer_api_request_duration_ms_count', 1, labels);
    });
    next();
  });

  app.use((req: Request, res: Response, next: NextFunction) => {
    const protectedPath = req.path === '/metrics' || req.path.startsWith('/api');
    if (!protectedPath) {
      next();
      return;
    }

    const windowMs = (config.api as any).rateLimitWindowMs ?? 60000;
    const maxRequests = (config.api as any).rateLimitMaxRequests ?? 120;
    const clientKey = req.ip || req.socket.remoteAddress || 'unknown';
    const now = Date.now();
    const bucket = rateLimitBuckets.get(clientKey);
    const nextBucket = !bucket || now >= bucket.resetAt
      ? { count: 0, resetAt: now + windowMs }
      : bucket;

    if (nextBucket.count >= maxRequests) {
      const retryAfterSeconds = Math.max(1, Math.ceil((nextBucket.resetAt - now) / 1000));
      metrics.incrementCounter('solana_indexer_api_rate_limited_total', 1, { path: req.path });
      res.setHeader('Retry-After', retryAfterSeconds);
      res.setHeader('X-RateLimit-Limit', maxRequests);
      res.setHeader('X-RateLimit-Remaining', 0);
      res.setHeader('X-RateLimit-Reset', Math.ceil(nextBucket.resetAt / 1000));
      res.status(429).json({ error: 'Rate limit exceeded', retryAfterSeconds });
      return;
    }

    nextBucket.count += 1;
    rateLimitBuckets.set(clientKey, nextBucket);
    res.setHeader('X-RateLimit-Limit', maxRequests);
    res.setHeader('X-RateLimit-Remaining', Math.max(0, maxRequests - nextBucket.count));
    res.setHeader('X-RateLimit-Reset', Math.ceil(nextBucket.resetAt / 1000));

    const authToken = (config.api as any).authToken as string | undefined;
    if (authToken) {
      const requestToken = extractApiToken(req);
      if (!requestToken || requestToken !== authToken) {
        metrics.incrementCounter('solana_indexer_api_auth_rejections_total', 1, { path: req.path });
        res.status(401).json({ error: 'Unauthorized', message: 'Provide a valid Bearer token or x-api-key header' });
        return;
      }
    }

    next();
  });

  app.get('/', (_req: Request, res: Response) => {
    const instructionCount = idl.instructions.length;
    const accountCount = idl.accounts?.length ?? 0;
    const eventCount = idl.events?.length ?? 0;
    const bootstrap = serializeForScript({
      program: {
        name: idl.name,
        version: idl.version,
      },
      apiAuthEnabled: Boolean((config.api as any).authToken),
      instructions: idl.instructions.map((ix) => ({
        name: ix.name,
        route: sanitizeSqlName(ix.name),
      })),
      events: (idl.events ?? []).map((event) => ({
        name: event.name,
        route: sanitizeSqlName(event.name),
      })),
      accounts: (idl.accounts ?? []).map((account) => ({
        name: account.name,
        route: sanitizeSqlName(account.name),
      })),
    });

    const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Solana Universal Indexer</title>
    <style>
      :root {
        color-scheme: light;
        --bg: #f7f5ef;
        --panel: #fffdf8;
        --text: #201d18;
        --muted: #6d665a;
        --accent: #155e75;
        --accent-2: #166534;
        --accent-soft: #e0f2fe;
        --accent-soft-2: #dcfce7;
        --border: #ded7ca;
        --table-stripe: #faf7f0;
      }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        font-family: "Segoe UI", system-ui, sans-serif;
        background:
          radial-gradient(circle at top left, #fff7ed 0, transparent 30%),
          radial-gradient(circle at top right, #ecfeff 0, transparent 28%),
          linear-gradient(180deg, #f8fafc 0%, var(--bg) 100%);
        color: var(--text);
      }
      main {
        max-width: 1180px;
        margin: 0 auto;
        padding: 40px 20px 64px;
      }
      .hero, .panel, .wide-panel {
        background: var(--panel);
        border: 1px solid var(--border);
        border-radius: 20px;
        box-shadow: 0 10px 30px rgba(15, 23, 42, 0.06);
      }
      .hero {
        padding: 28px;
        margin-bottom: 20px;
      }
      h1 {
        margin: 0 0 10px;
        font-size: 34px;
        line-height: 1.1;
      }
      .hero-top {
        display: flex;
        justify-content: space-between;
        gap: 16px;
        align-items: flex-start;
      }
      .status-chip {
        min-width: 180px;
        padding: 12px 14px;
        border-radius: 14px;
        background: #0f172a;
        color: white;
        font-weight: 600;
      }
      .status-chip small {
        display: block;
        margin-top: 6px;
        opacity: 0.78;
        font-weight: 500;
      }
      p {
        margin: 0;
        color: var(--muted);
        line-height: 1.6;
      }
      .pill-row, .grid {
        display: grid;
        gap: 12px;
      }
      .pill-row {
        grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
        margin-top: 22px;
      }
      .pill {
        padding: 14px 16px;
        border-radius: 14px;
        background: linear-gradient(135deg, var(--accent-soft) 0%, #f0fdf4 100%);
      }
      .pill strong {
        display: block;
        font-size: 22px;
      }
      .grid {
        grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
      }
      .three-up {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
        gap: 16px;
        margin-top: 16px;
      }
      .panel, .wide-panel {
        padding: 20px;
      }
      .wide-panel + .wide-panel {
        margin-top: 20px;
      }
      h2 {
        margin: 0 0 12px;
        font-size: 18px;
      }
      h3 {
        margin: 0 0 10px;
        font-size: 15px;
      }
      ul {
        margin: 0;
        padding-left: 18px;
      }
      li + li {
        margin-top: 8px;
      }
      a {
        color: var(--accent);
        text-decoration: none;
        font-weight: 600;
      }
      a:hover {
        text-decoration: underline;
      }
      code {
        font-family: Consolas, monospace;
        background: #f4f4f5;
        padding: 2px 6px;
        border-radius: 6px;
      }
      .controls {
        display: flex;
        flex-wrap: wrap;
        gap: 10px;
        margin-bottom: 14px;
      }
      .auth-row {
        margin-top: 16px;
        display: flex;
        flex-wrap: wrap;
        gap: 10px;
        align-items: center;
      }
      select, input, button {
        border-radius: 12px;
        border: 1px solid var(--border);
        padding: 10px 12px;
        font: inherit;
      }
      select, input {
        background: white;
        min-width: 170px;
      }
      button {
        background: linear-gradient(135deg, var(--accent) 0%, #0f766e 100%);
        color: white;
        font-weight: 700;
        cursor: pointer;
        border: none;
      }
      button.secondary {
        background: linear-gradient(135deg, var(--accent-2) 0%, #15803d 100%);
      }
      .table-shell {
        overflow: auto;
        border: 1px solid var(--border);
        border-radius: 16px;
      }
      table {
        width: 100%;
        border-collapse: collapse;
        min-width: 520px;
      }
      th, td {
        text-align: left;
        padding: 10px 12px;
        border-bottom: 1px solid #ebe5da;
        vertical-align: top;
      }
      th {
        background: #f8fafc;
        font-size: 13px;
        color: var(--muted);
        text-transform: uppercase;
        letter-spacing: 0.04em;
      }
      tbody tr:nth-child(even) {
        background: var(--table-stripe);
      }
      td pre {
        margin: 0;
        white-space: pre-wrap;
        word-break: break-word;
        font: 12px/1.45 Consolas, monospace;
      }
      .muted {
        color: var(--muted);
      }
      .empty-state {
        padding: 22px;
        color: var(--muted);
        text-align: center;
      }
      .panel-note {
        margin-top: 8px;
        font-size: 13px;
        color: var(--muted);
      }
      @media (max-width: 720px) {
        .hero-top {
          flex-direction: column;
        }
        .status-chip {
          width: 100%;
        }
      }
    </style>
  </head>
  <body>
    <main>
      <section class="hero">
        <div class="hero-top">
          <div>
            <h1>Solana Universal Indexer</h1>
            <p>
              The indexer is running for <code>${escapeHtml(idl.name)}</code> v${escapeHtml(idl.version)}.
              Use the live dashboard below to inspect health, stats, instructions, events, and accounts without writing manual API requests.
            </p>
          </div>
          <div class="status-chip" id="health-chip">
            Checking health...
            <small>Waiting for /health</small>
          </div>
        </div>
        <div class="pill-row">
          <div class="pill"><strong>${instructionCount}</strong><span>Instructions</span></div>
          <div class="pill"><strong>${accountCount}</strong><span>Account types</span></div>
          <div class="pill"><strong>${eventCount}</strong><span>Events</span></div>
        </div>
        <div class="auth-row" id="auth-row" style="display:none">
          <input id="api-token-input" type="password" placeholder="Enter API token for protected endpoints" style="flex:1 1 280px" />
          <button id="save-api-token" class="secondary">Save token</button>
        </div>
      </section>

      <section class="wide-panel">
        <h2>Program Stats</h2>
        <div class="three-up">
          <article class="panel">
            <h3>Core Metrics</h3>
            <div class="table-shell"><table><tbody id="stats-core"><tr><td class="muted">Loading...</td></tr></tbody></table></div>
          </article>
          <article class="panel">
            <h3>Instruction Counts</h3>
            <div class="table-shell"><table><tbody id="stats-instructions"><tr><td class="muted">Loading...</td></tr></tbody></table></div>
          </article>
          <article class="panel">
            <h3>Account Counts</h3>
            <div class="table-shell"><table><tbody id="stats-accounts"><tr><td class="muted">Loading...</td></tr></tbody></table></div>
          </article>
        </div>
        <p class="panel-note">Data is loaded from <code>/api/stats</code> when the page opens.</p>
      </section>

      <section class="wide-panel">
        <h2>Data Explorer</h2>
        <div class="three-up">
          <article class="panel">
            <h3>Instructions</h3>
            <div class="controls">
              <select id="instruction-select"></select>
              <input id="instruction-limit" type="number" min="1" max="100" value="10" />
              <button id="load-instructions">Load rows</button>
            </div>
            <div class="table-shell" id="instructions-result"></div>
          </article>
          <article class="panel">
            <h3>Events</h3>
            <div class="controls">
              <select id="event-select"></select>
              <input id="event-limit" type="number" min="1" max="100" value="10" />
              <button id="load-events" class="secondary">Load rows</button>
            </div>
            <div class="table-shell" id="events-result"></div>
          </article>
          <article class="panel">
            <h3>Accounts</h3>
            <div class="controls">
              <select id="account-select"></select>
              <input id="account-limit" type="number" min="1" max="100" value="10" />
              <button id="load-accounts">Latest rows</button>
            </div>
            <div class="controls">
              <input id="account-pubkey" type="text" placeholder="Pubkey for history lookup" style="flex:1 1 220px" />
              <button id="load-account-history" class="secondary">History by pubkey</button>
            </div>
            <div class="table-shell" id="accounts-result"></div>
          </article>
        </div>
      </section>

      <section class="grid">
        <article class="panel">
          <h2>Quick Checks</h2>
          <ul>
            <li><a href="/health">GET /health</a></li>
            <li><a href="/api/program">GET /api/program</a></li>
            <li><a href="/api/stats">GET /api/stats</a></li>
            <li><a href="/api">GET /api</a></li>
          </ul>
        </article>
        <article class="panel">
          <h2>Useful API Routes</h2>
          <ul>
            <li><a href="/api/transactions">GET /api/transactions</a></li>
            <li><a href="/api/instructions/${sanitizeSqlName(idl.instructions[0]?.name ?? '')}">Sample instruction route</a></li>
            <li><a href="/api/events/${sanitizeSqlName(idl.events?.[0]?.name ?? '')}">Sample event route</a></li>
            <li><a href="/api/accounts/${sanitizeSqlName(idl.accounts?.[0]?.name ?? '')}">Sample account route</a></li>
          </ul>
        </article>
      </section>
    </main>
    <script>
      const bootstrap = ${bootstrap};

      const byId = (id) => document.getElementById(id);
      const storedApiToken = () => window.localStorage.getItem('solana-indexer-api-token') || '';
      const escapeHtml = (value) => String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');

      function toCellContent(value) {
        if (value === null || value === undefined) return '';
        if (typeof value === 'object') return '<pre>' + escapeHtml(JSON.stringify(value, null, 2)) + '</pre>';
        return escapeHtml(String(value));
      }

      function renderMessage(targetId, message) {
        byId(targetId).innerHTML = '<div class="empty-state">' + escapeHtml(message) + '</div>';
      }

      function renderKeyValueRows(targetId, data) {
        const rows = Object.entries(data).map(([key, value]) =>
          '<tr><th>' + escapeHtml(key) + '</th><td>' + toCellContent(value) + '</td></tr>'
        ).join('');
        byId(targetId).innerHTML = rows || '<tr><td class="muted">No data</td></tr>';
      }

      function renderObjectTable(targetId, rows, preferredColumns) {
        if (!rows || rows.length === 0) {
          renderMessage(targetId, 'No rows found.');
          return;
        }

        const discoveredColumns = Array.from(
          rows.reduce((set, row) => {
            Object.keys(row).forEach((key) => set.add(key));
            return set;
          }, new Set())
        );
        const ordered = [
          ...preferredColumns.filter((key) => discoveredColumns.includes(key)),
          ...discoveredColumns.filter((key) => !preferredColumns.includes(key)),
        ];

        const head = ordered.map((column) => '<th>' + escapeHtml(column) + '</th>').join('');
        const body = rows.map((row) =>
          '<tr>' + ordered.map((column) => '<td>' + toCellContent(row[column]) + '</td>').join('') + '</tr>'
        ).join('');

        byId(targetId).innerHTML = '<table><thead><tr>' + head + '</tr></thead><tbody>' + body + '</tbody></table>';
      }

      async function fetchJson(url) {
        const headers = {};
        const apiToken = storedApiToken();
        if (apiToken) {
          headers['x-api-key'] = apiToken;
        }
        const response = await fetch(url, { headers });
        if (!response.ok) {
          const text = await response.text();
          throw new Error(text || ('Request failed: ' + response.status));
        }
        return response.json();
      }

      function fillSelect(selectId, items, emptyLabel) {
        const select = byId(selectId);
        const options = items.length
          ? items.map((item) => '<option value="' + escapeHtml(item.route) + '">' + escapeHtml(item.name) + '</option>').join('')
          : '<option value="">' + escapeHtml(emptyLabel) + '</option>';
        select.innerHTML = options;
        select.disabled = items.length === 0;
      }

      async function loadHealth() {
        const chip = byId('health-chip');
        try {
          const payload = await fetchJson('/health');
          chip.style.background = 'linear-gradient(135deg, #166534 0%, #15803d 100%)';
          chip.innerHTML = 'Healthy<small>Last check: ' + escapeHtml(payload.timestamp) + '</small>';
        } catch (error) {
          chip.style.background = 'linear-gradient(135deg, #991b1b 0%, #dc2626 100%)';
          chip.innerHTML = 'Unavailable<small>' + escapeHtml(error.message) + '</small>';
        }
      }

      async function loadStats() {
        try {
          const stats = await fetchJson('/api/stats');
          renderKeyValueRows('stats-core', {
            totalTransactions: stats.totalTransactions,
            successfulTransactions: stats.successfulTransactions,
            failedTransactions: stats.failedTransactions,
            firstIndexedAt: stats.firstIndexedAt,
            lastIndexedAt: stats.lastIndexedAt,
            lastProcessedSlot: stats.indexer?.lastProcessedSlot,
            mode: stats.indexer?.mode,
          });
          renderKeyValueRows('stats-instructions', stats.instructionCounts || {});
          renderKeyValueRows('stats-accounts', stats.accountCounts || {});
        } catch (error) {
          renderKeyValueRows('stats-core', { error: error.message });
          renderKeyValueRows('stats-instructions', {});
          renderKeyValueRows('stats-accounts', {});
        }
      }

      async function loadInstructionRows() {
        const route = byId('instruction-select').value;
        const limit = encodeURIComponent(byId('instruction-limit').value || '10');
        if (!route) {
          renderMessage('instructions-result', 'No instruction routes are available for this IDL.');
          return;
        }
        renderMessage('instructions-result', 'Loading...');
        const payload = await fetchJson('/api/instructions/' + route + '?limit=' + limit);
        renderObjectTable('instructions-result', payload.data, ['signature', 'slot', 'block_time', 'instruction_index']);
      }

      async function loadEventRows() {
        const route = byId('event-select').value;
        const limit = encodeURIComponent(byId('event-limit').value || '10');
        if (!route) {
          renderMessage('events-result', 'No event routes are available for this IDL.');
          return;
        }
        renderMessage('events-result', 'Loading...');
        const payload = await fetchJson('/api/events/' + route + '?limit=' + limit);
        renderObjectTable('events-result', payload.data, ['signature', 'slot', 'block_time', 'event_index']);
      }

      async function loadAccountRows() {
        const route = byId('account-select').value;
        const limit = encodeURIComponent(byId('account-limit').value || '10');
        if (!route) {
          renderMessage('accounts-result', 'No account routes are available for this IDL.');
          return;
        }
        renderMessage('accounts-result', 'Loading...');
        const payload = await fetchJson('/api/accounts/' + route + '?limit=' + limit);
        renderObjectTable('accounts-result', payload.data, ['pubkey', 'slot', 'owner', 'lamports', 'last_updated']);
      }

      async function loadAccountHistory() {
        const route = byId('account-select').value;
        const pubkey = byId('account-pubkey').value.trim();
        if (!route) {
          renderMessage('accounts-result', 'Choose an account type first.');
          return;
        }
        if (!pubkey) {
          renderMessage('accounts-result', 'Enter a pubkey to load account history.');
          return;
        }
        renderMessage('accounts-result', 'Loading history...');
        const payload = await fetchJson('/api/accounts/' + route + '/' + encodeURIComponent(pubkey) + '/history?limit=10');
        renderObjectTable('accounts-result', payload.history, ['pubkey', 'slot', 'signature', 'source_kind', 'captured_at']);
      }

      function wireUi() {
        if (bootstrap.apiAuthEnabled) {
          byId('auth-row').style.display = 'flex';
          byId('api-token-input').value = storedApiToken();
          byId('save-api-token').addEventListener('click', () => {
            window.localStorage.setItem('solana-indexer-api-token', byId('api-token-input').value.trim());
            loadHealth();
            loadStats();
          });
        }

        fillSelect('instruction-select', bootstrap.instructions, 'No instructions');
        fillSelect('event-select', bootstrap.events, 'No events');
        fillSelect('account-select', bootstrap.accounts, 'No accounts');

        byId('load-instructions').addEventListener('click', () => {
          loadInstructionRows().catch((error) => renderMessage('instructions-result', error.message));
        });
        byId('load-events').addEventListener('click', () => {
          loadEventRows().catch((error) => renderMessage('events-result', error.message));
        });
        byId('load-accounts').addEventListener('click', () => {
          loadAccountRows().catch((error) => renderMessage('accounts-result', error.message));
        });
        byId('load-account-history').addEventListener('click', () => {
          loadAccountHistory().catch((error) => renderMessage('accounts-result', error.message));
        });

        renderMessage('instructions-result', 'Choose an instruction and click "Load rows".');
        renderMessage('events-result', bootstrap.events.length ? 'Choose an event and click "Load rows".' : 'This IDL does not define Anchor events.');
        renderMessage('accounts-result', 'Choose an account type and click "Latest rows".');
      }

      wireUi();
      loadHealth();
      loadStats();
    </script>
  </body>
</html>`;

    res.type('html').send(html);
  });

  app.get('/health', async (_req: Request, res: Response) => {
    try {
      await getDb().raw('SELECT 1');
      res.json({ status: 'ok', timestamp: new Date().toISOString() });
    } catch {
      res.status(503).json({ status: 'error', message: 'Database unavailable' });
    }
  });

  app.get('/ready', async (_req: Request, res: Response) => {
    try {
      await getDb().raw('SELECT 1');
      const lifecycleState = metrics.getLifecycleState();
      const lagSlots = metrics.getGaugeValue('solana_indexer_realtime_lag_slots') ?? 0;
      const lagWarningSlots = (config.realtime as any)?.lagWarningSlots ?? 150;
      const realtimeMode = config.indexer.mode !== 'batch';
      const isReady = lifecycleState !== 'starting'
        && (!realtimeMode || lifecycleState === 'realtime_live')
        && (!realtimeMode || lagSlots <= lagWarningSlots * 2);

      res.status(isReady ? 200 : 503).json({
        status: isReady ? 'ready' : 'not_ready',
        lifecycleState,
        lagSlots,
      });
    } catch {
      res.status(503).json({ status: 'not_ready', message: 'Database unavailable' });
    }
  });

  app.get('/api/program', (_req: Request, res: Response) => {
    res.json({
      name: idl.name,
      version: idl.version,
      instructions: idl.instructions.map((ix) => ({
        name: ix.name,
        accounts: ix.accounts.map((a) => a.name),
        args: ix.args.map((a) => ({ name: a.name, type: a.type })),
      })),
      accounts: idl.accounts?.map((a) => ({
        name: a.name,
        fields: a.type.fields.map((f) => ({ name: f.name, type: f.type })),
      })) ?? [],
      events: idl.events?.map((e) => ({
        name: e.name,
        fields: e.fields.map((f) => ({ name: f.name, type: f.type })),
      })) ?? [],
    });
  });

  app.get('/api/stats', async (_req: Request, res: Response, next: NextFunction) => {
    try {
      const stats = await getProgramStats(idl);
      const lastSig = await getIndexerState('last_processed_signature');
      const lastSlot = await getIndexerState('last_processed_slot');

      res.json({
        ...stats,
        indexer: {
          lastProcessedSignature: lastSig,
          lastProcessedSlot: lastSlot ? Number.parseInt(lastSlot, 10) : null,
          mode: config.indexer.mode,
        },
      });
    } catch (err) {
      next(err);
    }
  });

  app.get('/api/transactions', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const db = getDb();
      let query = db('_transactions');

      if (req.query.success !== undefined) {
        query = query.where('success', req.query.success === 'true');
      }
      if (req.query.slot_from) {
        query = query.where('slot', '>=', parseNonNegativeInt(req.query.slot_from, 'slot_from'));
      }
      if (req.query.slot_to) {
        query = query.where('slot', '<=', parseNonNegativeInt(req.query.slot_to, 'slot_to'));
      }
      if (req.query.from) {
        query = query.where('block_time', '>=', parseDateFilter(req.query.from, 'from'));
      }
      if (req.query.to) {
        query = query.where('block_time', '<=', parseDateFilter(req.query.to, 'to'));
      }

      const limit = parseLimit(req.query.limit);
      const offset = parseOffset(req.query.offset);

      const [rows, countResult] = await Promise.all([
        query.clone().orderBy('slot', 'desc').limit(limit).offset(offset),
        query.clone().count('* as total').first(),
      ]);

      res.json({
        data: rows,
        pagination: {
          total: Number.parseInt(String(countResult?.total ?? 0), 10),
          limit,
          offset,
        },
      });
    } catch (err) {
      next(err);
    }
  });

  for (const ix of idl.instructions) {
    const ixRoute = sanitizeSqlName(ix.name);

    app.get(`/api/instructions/${ixRoute}`,
      async (req: Request, res: Response, next: NextFunction) => {
        try {
          const allowedColumns = buildInstructionColumnSet(ix);
          const filters: Record<string, any> = {};
          const reserved = ['limit', 'offset', 'order_by', 'order'];

          for (const [key, value] of Object.entries(req.query)) {
            if (reserved.includes(key)) continue;
            if (key.endsWith('_from') || key.endsWith('_to')) {
              const field = resolveColumn(key.replace(/_(from|to)$/, ''), allowedColumns, 'instruction filter column');
              if (!filters[field]) filters[field] = {};
              if (key.endsWith('_from')) filters[field].from = value;
              if (key.endsWith('_to')) filters[field].to = value;
            } else {
              const field = resolveColumn(key, allowedColumns, 'instruction filter column');
              filters[field] = value;
            }
          }

          const limit = parseLimit(req.query.limit);
          const offset = parseOffset(req.query.offset);
          const orderBy = req.query.order_by
            ? resolveColumn(req.query.order_by as string, allowedColumns, 'instruction order_by column')
            : undefined;

          const [rows, total] = await Promise.all([
            queryInstructions(idl, ix.name, filters, {
              limit,
              offset,
              orderBy,
              order: normalizeOrder(req.query.order as string),
            }),
            countInstructions(idl, ix.name, filters),
          ]);

          res.json({
            instruction: ix.name,
            data: rows,
            pagination: {
              total,
              limit,
              offset,
            },
          });
        } catch (err) {
          next(err);
        }
      },
    );

    app.get(`/api/instructions/${ixRoute}/aggregate`,
      async (req: Request, res: Response, next: NextFunction) => {
        try {
          const allowedColumns = buildInstructionColumnSet(ix);
          const rawInterval = req.query.interval as string | undefined;
          if (rawInterval && !VALID_INTERVALS.has(rawInterval)) {
            throw new ApiValidationError(`Invalid interval: ${rawInterval}`);
          }

          const result = await aggregateInstructions(idl, ix.name, {
            groupBy: req.query.group_by
              ? resolveColumn(req.query.group_by as string, allowedColumns, 'instruction group_by column')
              : undefined,
            from: req.query.from ? parseDateFilter(req.query.from, 'from') : undefined,
            to: req.query.to ? parseDateFilter(req.query.to, 'to') : undefined,
            interval: rawInterval as 'hour' | 'day' | 'week' | 'month' | undefined,
          });

          res.json({
            instruction: ix.name,
            aggregation: result,
          });
        } catch (err) {
          next(err);
        }
      },
    );
  }

  for (const event of idl.events ?? []) {
    const eventRoute = sanitizeSqlName(event.name);

    app.get(`/api/events/${eventRoute}`,
      async (req: Request, res: Response, next: NextFunction) => {
        try {
          const allowedColumns = buildEventColumnSet(event);
          const filters: Record<string, any> = {};
          const reserved = ['limit', 'offset', 'order_by', 'order'];

          for (const [key, value] of Object.entries(req.query)) {
            if (reserved.includes(key)) continue;
            if (key.endsWith('_from') || key.endsWith('_to')) {
              const field = resolveColumn(key.replace(/_(from|to)$/, ''), allowedColumns, 'event filter column');
              if (!filters[field]) filters[field] = {};
              if (key.endsWith('_from')) filters[field].from = value;
              if (key.endsWith('_to')) filters[field].to = value;
            } else {
              const field = resolveColumn(key, allowedColumns, 'event filter column');
              filters[field] = value;
            }
          }

          const limit = parseLimit(req.query.limit);
          const offset = parseOffset(req.query.offset);
          const orderBy = req.query.order_by
            ? resolveColumn(req.query.order_by as string, allowedColumns, 'event order_by column')
            : undefined;

          const [rows, total] = await Promise.all([
            queryEvents(idl, event.name, filters, {
              limit,
              offset,
              orderBy,
              order: normalizeOrder(req.query.order as string),
            }),
            countEvents(idl, event.name, filters),
          ]);

          res.json({
            event: event.name,
            data: rows,
            pagination: {
              total,
              limit,
              offset,
            },
          });
        } catch (err) {
          next(err);
        }
      },
    );

    app.get(`/api/events/${eventRoute}/aggregate`,
      async (req: Request, res: Response, next: NextFunction) => {
        try {
          const allowedColumns = buildEventColumnSet(event);
          const rawInterval = req.query.interval as string | undefined;
          if (rawInterval && !VALID_INTERVALS.has(rawInterval)) {
            throw new ApiValidationError(`Invalid interval: ${rawInterval}`);
          }

          const result = await aggregateEvents(idl, event.name, {
            groupBy: req.query.group_by
              ? resolveColumn(req.query.group_by as string, allowedColumns, 'event group_by column')
              : undefined,
            from: req.query.from ? parseDateFilter(req.query.from, 'from') : undefined,
            to: req.query.to ? parseDateFilter(req.query.to, 'to') : undefined,
            interval: rawInterval as 'hour' | 'day' | 'week' | 'month' | undefined,
          });

          res.json({
            event: event.name,
            aggregation: result,
          });
        } catch (err) {
          next(err);
        }
      },
    );
  }

  if (idl.accounts) {
    for (const acc of idl.accounts) {
      const accRoute = sanitizeSqlName(acc.name);

      app.get(`/api/accounts/${accRoute}`,
        async (req: Request, res: Response, next: NextFunction) => {
          try {
            const db = getDb();
            const tableName = getAccountTableName(idl, acc.name);
            let baseQuery = db(tableName);
            const allowedColumns = buildAccountColumnSet(acc);

            const reserved = ['limit', 'offset', 'order_by', 'order'];
            for (const [key, value] of Object.entries(req.query)) {
              if (reserved.includes(key)) continue;
              if (key.endsWith('_from')) {
                const field = resolveColumn(key.replace(/_from$/, ''), allowedColumns, 'account filter column');
                baseQuery = baseQuery.where(field, '>=', value as string);
              } else if (key.endsWith('_to')) {
                const field = resolveColumn(key.replace(/_to$/, ''), allowedColumns, 'account filter column');
                baseQuery = baseQuery.where(field, '<=', value as string);
              } else {
                const field = resolveColumn(key, allowedColumns, 'account filter column');
                baseQuery = baseQuery.where(field, value as string);
              }
            }

            const limit = parseLimit(req.query.limit);
            const offset = parseOffset(req.query.offset);
            const orderBy = req.query.order_by
              ? resolveColumn(req.query.order_by as string, allowedColumns, 'account order_by column')
              : 'last_updated';
            const order = normalizeOrder(req.query.order as string);

            const [rows, countResult] = await Promise.all([
              baseQuery.clone().orderBy(orderBy, order).limit(limit).offset(offset),
              baseQuery.clone().count('* as total').first(),
            ]);

            res.json({
              account: acc.name,
              data: rows,
              pagination: {
                total: Number.parseInt(String(countResult?.total ?? 0), 10),
                limit,
                offset,
              },
            });
          } catch (err) {
            next(err);
          }
        },
      );

      app.get(`/api/accounts/${accRoute}/:pubkey/history`,
        async (req: Request, res: Response, next: NextFunction) => {
          try {
            const allowedColumns = buildAccountHistoryColumnSet(acc);
            const filters: Record<string, any> = {};
            const reserved = ['limit', 'offset', 'order'];

            for (const [key, value] of Object.entries(req.query)) {
              if (reserved.includes(key)) continue;
              if (key.endsWith('_from') || key.endsWith('_to')) {
                const field = resolveColumn(key.replace(/_(from|to)$/, ''), allowedColumns, 'account history filter column');
                if (!filters[field]) filters[field] = {};
                if (key.endsWith('_from')) filters[field].from = value;
                if (key.endsWith('_to')) filters[field].to = value;
              } else {
                const field = resolveColumn(key, allowedColumns, 'account history filter column');
                filters[field] = value;
              }
            }

            const limit = parseLimit(req.query.limit);
            const offset = parseOffset(req.query.offset);
            const order = normalizeOrder(req.query.order as string);

            const [rows, total] = await Promise.all([
              queryAccountHistory(idl, acc.name, req.params.pubkey, filters, {
                limit,
                offset,
                order,
              }),
              countAccountHistory(idl, acc.name, req.params.pubkey, filters),
            ]);

            res.json({
              account: acc.name,
              pubkey: req.params.pubkey,
              history: rows,
              pagination: {
                total,
                limit,
                offset,
              },
            });
          } catch (err) {
            next(err);
          }
        },
      );

      app.get(`/api/accounts/${accRoute}/:pubkey`,
        async (req: Request, res: Response, next: NextFunction) => {
          try {
            const db = getDb();
            const tableName = getAccountTableName(idl, acc.name);
            const row = await db(tableName).where('pubkey', req.params.pubkey).first();

            if (!row) {
              res.status(404).json({ error: 'Account not found' });
              return;
            }

            res.json({ account: acc.name, data: row });
          } catch (err) {
            next(err);
          }
        },
      );
    }
  }

  app.get('/api', (_req: Request, res: Response) => {
    const endpoints = [
      'GET /health',
      'GET /api/program',
      'GET /api/stats',
      'GET /api/transactions',
    ];

    for (const ix of idl.instructions) {
      const r = sanitizeSqlName(ix.name);
      endpoints.push(`GET /api/instructions/${r}`);
      endpoints.push(`GET /api/instructions/${r}/aggregate`);
    }

    for (const event of idl.events ?? []) {
      const r = sanitizeSqlName(event.name);
      endpoints.push(`GET /api/events/${r}`);
      endpoints.push(`GET /api/events/${r}/aggregate`);
    }

    if (idl.accounts) {
      for (const acc of idl.accounts) {
        const r = sanitizeSqlName(acc.name);
        endpoints.push(`GET /api/accounts/${r}`);
        endpoints.push(`GET /api/accounts/${r}/:pubkey/history`);
        endpoints.push(`GET /api/accounts/${r}/:pubkey`);
      }
    }

    res.json({ endpoints });
  });

  app.get('/metrics', (_req: Request, res: Response) => {
    if (!(config.api as any).enableMetrics) {
      res.status(404).type('text/plain').send('metrics disabled');
      return;
    }

    res.type('text/plain').send(metrics.renderPrometheus());
  });

  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof ApiValidationError) {
      res.status(400).json({ error: 'Bad request', message: err.message });
      return;
    }

    log.error({ error: err.message, stack: err.stack }, 'API error');
    res.status(500).json({ error: 'Internal server error', message: err.message });
  });

  return app;
}

export function startApi(app: express.Application): Promise<ReturnType<typeof app.listen>> {
  return new Promise((resolve) => {
    const server = app.listen(config.api.port, config.api.host, () => {
      log.info(
        { host: config.api.host, port: config.api.port },
        'API server started',
      );
      resolve(server);
    });
  });
}
