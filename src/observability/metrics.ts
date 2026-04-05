type LabelValue = string | number | boolean | null | undefined;
type Labels = Record<string, LabelValue>;

function formatLabels(labels: Labels): string {
  const entries = Object.entries(labels)
    .filter(([, value]) => value !== undefined && value !== null)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}="${String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`);

  return entries.length > 0 ? `{${entries.join(',')}}` : '';
}

function labelsKey(labels: Labels): string {
  return Object.entries(labels)
    .filter(([, value]) => value !== undefined && value !== null)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}:${String(value)}`)
    .join('|');
}

class MetricsRegistry {
  private readonly startedAt = Date.now();
  private readonly counters = new Map<string, Map<string, { labels: Labels; value: number }>>();
  private readonly gauges = new Map<string, Map<string, { labels: Labels; value: number }>>();
  private lifecycleState = 'starting';

  incrementCounter(name: string, value = 1, labels: Labels = {}): void {
    const bucket = this.counters.get(name) ?? new Map<string, { labels: Labels; value: number }>();
    const key = labelsKey(labels);
    const current = bucket.get(key);
    bucket.set(key, {
      labels,
      value: (current?.value ?? 0) + value,
    });
    this.counters.set(name, bucket);
  }

  setGauge(name: string, value: number, labels: Labels = {}): void {
    const bucket = this.gauges.get(name) ?? new Map<string, { labels: Labels; value: number }>();
    bucket.set(labelsKey(labels), { labels, value });
    this.gauges.set(name, bucket);
  }

  setLifecycleState(state: string): void {
    this.lifecycleState = state;
  }

  getLifecycleState(): string {
    return this.lifecycleState;
  }

  getGaugeValue(name: string, labels: Labels = {}): number | null {
    const bucket = this.gauges.get(name);
    if (!bucket) return null;
    return bucket.get(labelsKey(labels))?.value ?? null;
  }

  renderPrometheus(): string {
    this.setGauge('process_uptime_seconds', (Date.now() - this.startedAt) / 1000);
    const memory = process.memoryUsage();
    this.setGauge('process_resident_memory_bytes', memory.rss);
    this.setGauge('process_heap_used_bytes', memory.heapUsed);
    this.setGauge('process_heap_total_bytes', memory.heapTotal);

    const lifecycleStates = ['starting', 'api_ready', 'batch_running', 'batch_complete', 'realtime_gap_fill', 'realtime_live', 'stopping', 'stopped', 'error'];
    for (const state of lifecycleStates) {
      this.setGauge('solana_indexer_lifecycle_state', this.lifecycleState === state ? 1 : 0, { state });
    }

    const lines: string[] = [];

    for (const [name, bucket] of this.counters) {
      for (const entry of bucket.values()) {
        lines.push(`${name}${formatLabels(entry.labels)} ${entry.value}`);
      }
    }

    for (const [name, bucket] of this.gauges) {
      for (const entry of bucket.values()) {
        lines.push(`${name}${formatLabels(entry.labels)} ${entry.value}`);
      }
    }

    return `${lines.join('\n')}\n`;
  }
}

export const metrics = new MetricsRegistry();
