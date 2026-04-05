import { useEffect, useState } from 'react'
import type { FormEvent, ReactNode } from 'react'
import './App.css'
import {
  ApiError,
  fetchJson,
  fetchText,
  type AccountItem,
  type ApiDiscovery,
  type EventItem,
  type ProgramMetadata,
  type ProgramStats,
  type ReadinessPayload,
  type TableResponse,
  type TransactionsResponse,
} from './api'

type AsyncState<T> = {
  loading: boolean
  error: string | null
  data: T | null
}

type StatusSnapshot = {
  health: { ok: boolean; payload: unknown | null }
  ready: { ok: boolean; payload: ReadinessPayload | null }
  metrics: { ok: boolean; preview: string[] }
}

type ResourceKind = 'instructions' | 'events' | 'accounts'

type ResourceOption = {
  label: string
  route: string
}

type MetadataEntry = {
  name: string
  route?: string
  fields?: Array<{ name: string; type: unknown }>
  accounts?: string[]
  args?: Array<{ name: string; type: unknown }>
}

const TOKEN_STORAGE_KEY = 'solana-indexer-demo-token'

function createAsyncState<T>(data: T | null = null): AsyncState<T> {
  return {
    loading: false,
    error: null,
    data,
  }
}

function toErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    return `${error.status}: ${error.message}`
  }
  if (error instanceof Error) {
    return error.message
  }
  return 'Unknown error'
}

function formatValue(value: unknown): string {
  if (value === null || value === undefined) return '—'
  if (typeof value === 'object') return JSON.stringify(value)
  return String(value)
}

function Section({
  title,
  action,
  children,
}: {
  title: string
  action?: ReactNode
  children: ReactNode
}) {
  return (
    <section className="panel">
      <div className="panel__header">
        <h2>{title}</h2>
        {action}
      </div>
      {children}
    </section>
  )
}

function StatusBadge({ label, ok }: { label: string; ok: boolean }) {
  return (
    <div className={`status-badge ${ok ? 'status-badge--ok' : 'status-badge--error'}`}>
      <span>{label}</span>
      <strong>{ok ? 'ok' : 'failed'}</strong>
    </div>
  )
}

function LoadingState({ label }: { label: string }) {
  return <div className="state-box">Loading {label}...</div>
}

function ErrorState({ message }: { message: string }) {
  return <div className="state-box state-box--error">{message}</div>
}

function EmptyState({ message }: { message: string }) {
  return <div className="state-box">{message}</div>
}

function DataTable({
  rows,
  preferredColumns,
}: {
  rows: Record<string, unknown>[]
  preferredColumns: string[]
}) {
  const discoveredColumns = rows.reduce<string[]>((columns, row) => {
    Object.keys(row).forEach((key) => {
      if (!columns.includes(key)) {
        columns.push(key)
      }
    })
    return columns
  }, [])

  const orderedColumns = [
    ...preferredColumns.filter((column) => discoveredColumns.includes(column)),
    ...discoveredColumns.filter((column) => !preferredColumns.includes(column)),
  ]

  if (orderedColumns.length === 0) {
    return <EmptyState message="No columns to display." />
  }

  return (
    <div className="table-shell">
      <table>
        <thead>
          <tr>
            {orderedColumns.map((column) => (
              <th key={column}>{column}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => (
            <tr key={`${index}-${row.signature ?? row.pubkey ?? row.id ?? 'row'}`}>
              {orderedColumns.map((column) => {
                const value = row[column]
                return (
                  <td key={column}>
                    {typeof value === 'object' && value !== null ? (
                      <pre>{JSON.stringify(value, null, 2)}</pre>
                    ) : (
                      formatValue(value)
                    )}
                  </td>
                )
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function MetadataList({
  title,
  items,
  renderFields,
}: {
  title: string
  items: MetadataEntry[]
  renderFields: (item: MetadataEntry) => ReactNode
}) {
  return (
    <article className="metadata-card">
      <h3>{title}</h3>
      {items.length === 0 ? (
        <EmptyState message={`No ${title.toLowerCase()} discovered.`} />
      ) : (
        <ul className="metadata-list">
          {items.map((item) => (
            <li key={item.name}>
              <div className="metadata-list__title">
                <strong>{item.name}</strong>
                {item.route ? <code>{item.route}</code> : null}
              </div>
              {renderFields(item)}
            </li>
          ))}
        </ul>
      )}
    </article>
  )
}

function App() {
  const [apiToken, setApiToken] = useState(() => window.localStorage.getItem(TOKEN_STORAGE_KEY) ?? '')
  const [statusState, setStatusState] = useState<AsyncState<StatusSnapshot>>(createAsyncState())
  const [statsState, setStatsState] = useState<AsyncState<ProgramStats>>(createAsyncState())
  const [metadataState, setMetadataState] = useState<AsyncState<ProgramMetadata>>(createAsyncState())
  const [discoveryState, setDiscoveryState] = useState<AsyncState<ApiDiscovery>>(createAsyncState())
  const [transactionsState, setTransactionsState] = useState<AsyncState<TransactionsResponse>>(createAsyncState())
  const [transactionsLimit, setTransactionsLimit] = useState('10')
  const [transactionsOffset, setTransactionsOffset] = useState('0')
  const [resourceState, setResourceState] = useState<AsyncState<TableResponse>>(createAsyncState())
  const [resourceKind, setResourceKind] = useState<ResourceKind>('accounts')
  const [resourceRoute, setResourceRoute] = useState('')
  const [resourceLimit, setResourceLimit] = useState('10')
  const [resourceOffset, setResourceOffset] = useState('0')
  const [playgroundState, setPlaygroundState] = useState<AsyncState<unknown>>(createAsyncState())
  const [playgroundLimit, setPlaygroundLimit] = useState('5')
  const [playgroundSlotFrom, setPlaygroundSlotFrom] = useState('')
  const [playgroundSlotTo, setPlaygroundSlotTo] = useState('')
  const [playgroundSuccess, setPlaygroundSuccess] = useState('true')

  const resourceOptions: Record<ResourceKind, ResourceOption[]> = {
    instructions: metadataState.data?.instructions.map((instruction) => ({
      label: instruction.name,
      route: instruction.route,
    })) ?? [],
    events: metadataState.data?.events.map((event) => ({
      label: event.name,
      route: event.route,
    })) ?? [],
    accounts: metadataState.data?.accounts.map((account) => ({
      label: account.name,
      route: account.route,
    })) ?? [],
  }

  useEffect(() => {
    const preferredKind = resourceOptions.accounts.length > 0
      ? 'accounts'
      : resourceOptions.events.length > 0
        ? 'events'
        : 'instructions'
    setResourceKind(preferredKind)
  }, [resourceOptions.accounts.length, resourceOptions.events.length, resourceOptions.instructions.length])

  useEffect(() => {
    const nextRoute = resourceOptions[resourceKind][0]?.route ?? ''
    setResourceRoute((currentRoute) => (
      currentRoute && resourceOptions[resourceKind].some((item) => item.route === currentRoute)
        ? currentRoute
        : nextRoute
    ))
  }, [resourceKind, metadataState.data])

  async function runStatusRefresh() {
    setStatusState((current) => ({ ...current, loading: true, error: null }))
    try {
      const [health, ready, metricsText] = await Promise.all([
        fetchJson('/health', apiToken),
        fetchJson<ReadinessPayload>('/ready', apiToken),
        fetchText('/metrics', apiToken),
      ])

      setStatusState({
        loading: false,
        error: null,
        data: {
          health: { ok: true, payload: health },
          ready: { ok: true, payload: ready },
          metrics: {
            ok: metricsText.includes('solana_indexer_lifecycle_state'),
            preview: metricsText.split('\n').filter(Boolean).slice(0, 5),
          },
        },
      })
    } catch (error) {
      setStatusState({
        loading: false,
        error: toErrorMessage(error),
        data: null,
      })
    }
  }

  async function runStatsRefresh() {
    setStatsState((current) => ({ ...current, loading: true, error: null }))
    try {
      const stats = await fetchJson<ProgramStats>('/api/stats', apiToken)
      setStatsState({ loading: false, error: null, data: stats })
    } catch (error) {
      setStatsState({ loading: false, error: toErrorMessage(error), data: null })
    }
  }

  async function runMetadataRefresh() {
    setMetadataState((current) => ({ ...current, loading: true, error: null }))
    setDiscoveryState((current) => ({ ...current, loading: true, error: null }))

    try {
      const [metadata, discovery] = await Promise.all([
        fetchJson<ProgramMetadata>('/api/program', apiToken),
        fetchJson<ApiDiscovery>('/api', apiToken),
      ])
      setMetadataState({ loading: false, error: null, data: metadata })
      setDiscoveryState({ loading: false, error: null, data: discovery })
    } catch (error) {
      const message = toErrorMessage(error)
      setMetadataState({ loading: false, error: message, data: null })
      setDiscoveryState({ loading: false, error: message, data: null })
    }
  }

  async function runTransactionsRefresh() {
    setTransactionsState((current) => ({ ...current, loading: true, error: null }))
    const params = new URLSearchParams({
      limit: transactionsLimit || '10',
      offset: transactionsOffset || '0',
    })

    try {
      const response = await fetchJson<TransactionsResponse>(`/api/transactions?${params.toString()}`, apiToken)
      setTransactionsState({ loading: false, error: null, data: response })
    } catch (error) {
      setTransactionsState({ loading: false, error: toErrorMessage(error), data: null })
    }
  }

  async function runResourceRefresh(nextKind = resourceKind, nextRoute = resourceRoute) {
    if (!nextRoute) {
      setResourceState({ loading: false, error: null, data: null })
      return
    }

    setResourceState((current) => ({ ...current, loading: true, error: null }))
    const params = new URLSearchParams({
      limit: resourceLimit || '10',
      offset: resourceOffset || '0',
    })

    const basePath = nextKind === 'instructions'
      ? `/api/instructions/${nextRoute}`
      : nextKind === 'events'
        ? `/api/events/${nextRoute}`
        : `/api/accounts/${nextRoute}`

    try {
      const response = await fetchJson<TableResponse>(`${basePath}?${params.toString()}`, apiToken)
      setResourceState({ loading: false, error: null, data: response })
    } catch (error) {
      setResourceState({ loading: false, error: toErrorMessage(error), data: null })
    }
  }

  async function runPlaygroundRequest(path: string) {
    setPlaygroundState({ loading: true, error: null, data: null })
    try {
      const response = await fetchJson(path, apiToken)
      setPlaygroundState({ loading: false, error: null, data: response })
    } catch (error) {
      setPlaygroundState({ loading: false, error: toErrorMessage(error), data: null })
    }
  }

  async function handleTransactionsFilter(event: FormEvent) {
    event.preventDefault()
    const params = new URLSearchParams({
      limit: playgroundLimit || '5',
    })

    if (playgroundSuccess !== 'any') {
      params.set('success', playgroundSuccess)
    }
    if (playgroundSlotFrom) {
      params.set('slot_from', playgroundSlotFrom)
    }
    if (playgroundSlotTo) {
      params.set('slot_to', playgroundSlotTo)
    }

    await runPlaygroundRequest(`/api/transactions?${params.toString()}`)
  }

  useEffect(() => {
    void runStatusRefresh()
    void runStatsRefresh()
    void runMetadataRefresh()
    void runTransactionsRefresh()
  }, [apiToken])

  useEffect(() => {
    if (resourceRoute) {
      void runResourceRefresh(resourceKind, resourceRoute)
    }
  }, [apiToken, resourceKind, resourceRoute])

  function saveToken() {
    window.localStorage.setItem(TOKEN_STORAGE_KEY, apiToken)
    void runStatusRefresh()
    void runStatsRefresh()
    void runMetadataRefresh()
    void runTransactionsRefresh()
    if (resourceRoute) {
      void runResourceRefresh(resourceKind, resourceRoute)
    }
  }

  const indexerStateRows = statsState.data
    ? [
        ['mode', statsState.data.indexer.mode],
        ['lastProcessedSlot', statsState.data.indexer.lastProcessedSlot],
        ['lastProcessedSignature', statsState.data.indexer.lastProcessedSignature],
        ['totalTransactions', statsState.data.totalTransactions],
        ['successfulTransactions', statsState.data.successfulTransactions],
        ['failedTransactions', statsState.data.failedTransactions],
        ['firstIndexedAt', statsState.data.firstIndexedAt],
        ['lastIndexedAt', statsState.data.lastIndexedAt],
      ]
    : []

  const resourceRows = resourceState.data?.data ?? []
  const transactionsRows = transactionsState.data?.data ?? []
  const firstInstructionRoute = metadataState.data?.instructions[0]?.route
  const firstEventRoute = metadataState.data?.events[0]?.route

  return (
    <div className="app-shell">
      <header className="hero">
        <div>
          <p className="eyebrow">Reviewer Demo Console</p>
          <h1>Solana Universal Indexer</h1>
          <p className="hero__text">
            A compact React console for reviewers to verify backend health, indexer state, indexed data,
            filtering, stats, aggregation, and generated metadata without manual curl work.
          </p>
        </div>
        <div className="token-box">
          <label htmlFor="api-token">API token</label>
          <input
            id="api-token"
            type="password"
            value={apiToken}
            onChange={(event) => setApiToken(event.target.value)}
            placeholder="Optional Bearer token"
          />
          <button onClick={saveToken}>Apply token</button>
        </div>
      </header>

      <div className="layout-grid">
        <Section title="Status Panel" action={<button onClick={() => void runStatusRefresh()}>Refresh</button>}>
          {statusState.loading ? <LoadingState label="status" /> : null}
          {statusState.error ? <ErrorState message={statusState.error} /> : null}
          {statusState.data ? (
            <>
              <div className="status-grid">
                <StatusBadge label="backend reachable" ok />
                <StatusBadge label="/health" ok={statusState.data.health.ok} />
                <StatusBadge label="/ready" ok={statusState.data.ready.ok} />
                <StatusBadge label="/metrics" ok={statusState.data.metrics.ok} />
              </div>
              <div className="details-grid">
                <div className="detail-card">
                  <h3>Health payload</h3>
                  <pre>{JSON.stringify(statusState.data.health.payload, null, 2)}</pre>
                </div>
                <div className="detail-card">
                  <h3>Readiness payload</h3>
                  <pre>{JSON.stringify(statusState.data.ready.payload, null, 2)}</pre>
                </div>
                <div className="detail-card">
                  <h3>Metrics preview</h3>
                  <pre>{statusState.data.metrics.preview.join('\n')}</pre>
                </div>
              </div>
            </>
          ) : null}
        </Section>

        <Section title="Indexer State Panel" action={<button onClick={() => void runStatsRefresh()}>Refresh</button>}>
          {statsState.loading ? <LoadingState label="indexer state" /> : null}
          {statsState.error ? <ErrorState message={statsState.error} /> : null}
          {!statsState.loading && !statsState.error && !statsState.data ? <EmptyState message="No stats loaded yet." /> : null}
          {statsState.data ? (
            <div className="details-grid">
              <div className="detail-card">
                <h3>Indexer state</h3>
                <table className="kv-table">
                  <tbody>
                    {indexerStateRows.map(([label, value]) => (
                      <tr key={label}>
                        <th>{label}</th>
                        <td>{formatValue(value)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="detail-card">
                <h3>Instruction counts</h3>
                <pre>{JSON.stringify(statsState.data.instructionCounts, null, 2)}</pre>
              </div>
              <div className="detail-card">
                <h3>Account counts</h3>
                <pre>{JSON.stringify(statsState.data.accountCounts, null, 2)}</pre>
              </div>
            </div>
          ) : null}
        </Section>

        <Section
          title="Data Tables"
          action={
            <div className="inline-controls">
              <button onClick={() => void runTransactionsRefresh()}>Refresh transactions</button>
              <button onClick={() => void runResourceRefresh()} className="button-secondary">Refresh resource</button>
            </div>
          }
        >
          <div className="table-panels">
            <article className="sub-panel">
              <div className="sub-panel__header">
                <h3>Transactions</h3>
                <div className="inline-controls">
                  <label>
                    limit
                    <input value={transactionsLimit} onChange={(event) => setTransactionsLimit(event.target.value)} />
                  </label>
                  <label>
                    offset
                    <input value={transactionsOffset} onChange={(event) => setTransactionsOffset(event.target.value)} />
                  </label>
                </div>
              </div>
              {transactionsState.loading ? <LoadingState label="transactions" /> : null}
              {transactionsState.error ? <ErrorState message={transactionsState.error} /> : null}
              {!transactionsState.loading && !transactionsState.error && transactionsRows.length === 0 ? (
                <EmptyState message="No transactions returned." />
              ) : null}
              {transactionsRows.length > 0 ? (
                <>
                  <DataTable rows={transactionsRows as Record<string, unknown>[]} preferredColumns={['signature', 'slot', 'block_time', 'success', 'indexed_at']} />
                  <p className="hint">
                    total: {transactionsState.data?.pagination.total ?? 0} | limit: {transactionsState.data?.pagination.limit ?? 0} | offset: {transactionsState.data?.pagination.offset ?? 0}
                  </p>
                </>
              ) : null}
            </article>

            <article className="sub-panel">
              <div className="sub-panel__header">
                <h3>Accounts / Events / Instructions</h3>
                <div className="inline-controls inline-controls--stack">
                  <label>
                    type
                    <select value={resourceKind} onChange={(event) => setResourceKind(event.target.value as ResourceKind)}>
                      <option value="accounts" disabled={resourceOptions.accounts.length === 0}>accounts</option>
                      <option value="events" disabled={resourceOptions.events.length === 0}>events</option>
                      <option value="instructions" disabled={resourceOptions.instructions.length === 0}>instructions</option>
                    </select>
                  </label>
                  <label>
                    route
                    <select value={resourceRoute} onChange={(event) => setResourceRoute(event.target.value)}>
                      {resourceOptions[resourceKind].map((option) => (
                        <option key={option.route} value={option.route}>
                          {option.label}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    limit
                    <input value={resourceLimit} onChange={(event) => setResourceLimit(event.target.value)} />
                  </label>
                  <label>
                    offset
                    <input value={resourceOffset} onChange={(event) => setResourceOffset(event.target.value)} />
                  </label>
                </div>
              </div>
              {resourceState.loading ? <LoadingState label="resource table" /> : null}
              {resourceState.error ? <ErrorState message={resourceState.error} /> : null}
              {!resourceRoute ? <EmptyState message="No discovered route is available for this resource type." /> : null}
              {!resourceState.loading && !resourceState.error && resourceRoute && resourceRows.length === 0 ? (
                <EmptyState message="No rows returned." />
              ) : null}
              {resourceRows.length > 0 ? (
                <>
                  <DataTable rows={resourceRows as Record<string, unknown>[]} preferredColumns={['signature', 'slot', 'block_time', 'pubkey', 'owner', 'last_updated']} />
                  <p className="hint">
                    total: {resourceState.data?.pagination?.total ?? 0} | limit: {resourceState.data?.pagination?.limit ?? 0} | offset: {resourceState.data?.pagination?.offset ?? 0}
                  </p>
                </>
              ) : null}
            </article>
          </div>
        </Section>

        <Section title="API Playground">
          <div className="playground-grid">
            <article className="sub-panel">
              <h3>Transactions filter</h3>
              <form className="form-grid" onSubmit={(event) => void handleTransactionsFilter(event)}>
                <label>
                  success
                  <select value={playgroundSuccess} onChange={(event) => setPlaygroundSuccess(event.target.value)}>
                    <option value="true">true</option>
                    <option value="false">false</option>
                    <option value="any">any</option>
                  </select>
                </label>
                <label>
                  slot_from
                  <input value={playgroundSlotFrom} onChange={(event) => setPlaygroundSlotFrom(event.target.value)} placeholder="optional" />
                </label>
                <label>
                  slot_to
                  <input value={playgroundSlotTo} onChange={(event) => setPlaygroundSlotTo(event.target.value)} placeholder="optional" />
                </label>
                <label>
                  limit
                  <input value={playgroundLimit} onChange={(event) => setPlaygroundLimit(event.target.value)} />
                </label>
                <div className="inline-controls">
                  <button type="submit">Run filter</button>
                </div>
              </form>
            </article>

            <article className="sub-panel">
              <h3>Built-in example queries</h3>
              <div className="button-grid">
                <button onClick={() => void runPlaygroundRequest('/api/stats')}>Load stats</button>
                <button onClick={() => void runPlaygroundRequest('/api/transactions?success=true&limit=5')} className="button-secondary">
                  Successful transactions
                </button>
                <button
                  onClick={() => void runPlaygroundRequest(firstInstructionRoute ? `/api/instructions/${firstInstructionRoute}/aggregate?interval=day` : '/api/stats')}
                  disabled={!firstInstructionRoute}
                >
                  Aggregate first instruction
                </button>
                <button
                  onClick={() => void runPlaygroundRequest(firstEventRoute ? `/api/events/${firstEventRoute}/aggregate?interval=day` : '/api/stats')}
                  disabled={!firstEventRoute}
                  className="button-secondary"
                >
                  Aggregate first event
                </button>
              </div>
            </article>
          </div>

          {playgroundState.loading ? <LoadingState label="playground response" /> : null}
          {playgroundState.error ? <ErrorState message={playgroundState.error} /> : null}
          {!playgroundState.loading && !playgroundState.error && !playgroundState.data ? (
            <EmptyState message="Run a filter or one of the example queries to inspect raw JSON responses." />
          ) : null}
          {playgroundState.data ? (
            <div className="json-shell">
              <pre>{JSON.stringify(playgroundState.data, null, 2)}</pre>
            </div>
          ) : null}
        </Section>

        <Section title="Generated Schema / Metadata View" action={<button onClick={() => void runMetadataRefresh()}>Refresh</button>}>
          {metadataState.loading ? <LoadingState label="program metadata" /> : null}
          {metadataState.error ? <ErrorState message={metadataState.error} /> : null}
          {!metadataState.loading && !metadataState.error && !metadataState.data ? <EmptyState message="Metadata is not available." /> : null}
          {metadataState.data ? (
            <>
              <div className="metadata-summary">
                <div>
                  <span className="metadata-label">program</span>
                  <strong>{metadataState.data.name}</strong>
                </div>
                <div>
                  <span className="metadata-label">version</span>
                  <strong>{metadataState.data.version}</strong>
                </div>
                <div>
                  <span className="metadata-label">discovered endpoints</span>
                  <strong>{discoveryState.data?.endpoints.length ?? 0}</strong>
                </div>
              </div>
              <div className="metadata-grid">
                <MetadataList
                  title="Instructions"
                  items={metadataState.data.instructions}
                  renderFields={(item) => (
                    <p className="metadata-copy">
                      accounts: {item.accounts?.join(', ') || 'none'} | args: {item.args?.map((arg: { name: string }) => arg.name).join(', ') || 'none'}
                    </p>
                  )}
                />
                <MetadataList
                  title="Accounts"
                  items={metadataState.data.accounts as AccountItem[]}
                  renderFields={(item) => (
                    <p className="metadata-copy">
                      fields: {item.fields?.map((field: { name: string }) => field.name).join(', ') || 'none'}
                    </p>
                  )}
                />
                <MetadataList
                  title="Events"
                  items={metadataState.data.events as EventItem[]}
                  renderFields={(item) => (
                    <p className="metadata-copy">
                      fields: {item.fields?.map((field: { name: string }) => field.name).join(', ') || 'none'}
                    </p>
                  )}
                />
              </div>
            </>
          ) : null}
        </Section>
      </div>
    </div>
  )
}

export default App
