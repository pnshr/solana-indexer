export class ApiError extends Error {
  status: number

  constructor(status: number, message: string) {
    super(message)
    this.name = 'ApiError'
    this.status = status
  }
}

export type ProgramMetadata = {
  name: string
  version: string
  instructions: Array<{
    name: string
    route: string
    accounts: string[]
    args: Array<{ name: string; type: unknown }>
  }>
  accounts: Array<{
    name: string
    route: string
    fields: Array<{ name: string; type: unknown }>
  }>
  events: Array<{
    name: string
    route: string
    fields: Array<{ name: string; type: unknown }>
  }>
}

export type ApiDiscovery = {
  endpoints: string[]
}

export type ProgramStats = {
  totalTransactions: number
  successfulTransactions: number
  failedTransactions: number
  instructionCounts: Record<string, number>
  eventCounts?: Record<string, number>
  accountCounts: Record<string, number>
  firstIndexedAt: string | null
  lastIndexedAt: string | null
  indexer: {
    mode: string | null
    lastProcessedSignature: string | null
    lastProcessedSlot: number | null
  }
}

export type ReadinessPayload = {
  status: string
  lifecycleState?: string
  lagSlots?: number
  message?: string
}

export type Pagination = {
  total: number
  limit: number
  offset: number
}

export type TransactionsResponse = {
  data: Array<Record<string, unknown>>
  pagination: Pagination
}

export type TableResponse = {
  instruction?: string
  event?: string
  account?: string
  data?: Array<Record<string, unknown>>
  history?: Array<Record<string, unknown>>
  pagination?: Pagination
}

export type AccountItem = ProgramMetadata['accounts'][number]
export type EventItem = ProgramMetadata['events'][number]

const baseUrl = import.meta.env.VITE_API_BASE_URL ?? ''

function createHeaders(token?: string): HeadersInit {
  if (!token) {
    return {}
  }

  return {
    Authorization: `Bearer ${token}`,
  }
}

async function parseError(response: Response): Promise<never> {
  const contentType = response.headers.get('content-type') ?? ''

  if (contentType.includes('application/json')) {
    const payload = await response.json() as { message?: string; error?: string }
    throw new ApiError(response.status, payload.message ?? payload.error ?? `Request failed with ${response.status}`)
  }

  throw new ApiError(response.status, await response.text())
}

export async function fetchJson<T>(path: string, token?: string): Promise<T> {
  const response = await fetch(`${baseUrl}${path}`, {
    headers: createHeaders(token),
  })

  if (!response.ok) {
    return parseError(response)
  }

  return response.json() as Promise<T>
}

export async function fetchText(path: string, token?: string): Promise<string> {
  const response = await fetch(`${baseUrl}${path}`, {
    headers: createHeaders(token),
  })

  if (!response.ok) {
    return parseError(response)
  }

  return response.text()
}
