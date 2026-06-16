import type { Bus } from '../../types';
import type { PairWithStatus, SyncEndpoint } from '../messages';

export interface PairInput {
  source: SyncEndpoint;
  target: SyncEndpoint;
  intervalMs?: number;
  exclusions?: string[];
}

export interface DirSyncClient {
  list(): Promise<PairWithStatus[]>;
  create(input: PairInput): Promise<{ pair?: PairWithStatus; error?: string }>;
  update(id: string, input: PairInput): Promise<{ pair?: PairWithStatus; error?: string }>;
  setEnabled(id: string, enabled: boolean): Promise<{ ok?: boolean; error?: string }>;
  remove(id: string): Promise<{ ok?: boolean; error?: string }>;
  syncNow(id: string): Promise<{ ok?: boolean; error?: string }>;
  // Any pair or status change on the backend. Returns an unsubscribe fn.
  onChanged(handler: () => void): () => void;
}

export function createClient(bus: Bus): DirSyncClient {
  return {
    async list() {
      const r = await bus.application.request<{ pairs: PairWithStatus[] }>('pairs.list', {});
      return r?.pairs || [];
    },
    create: (input) => bus.application.request('pairs.create', input),
    update: (id, input) => bus.application.request('pairs.update', { id, ...input }),
    setEnabled: (id, enabled) => bus.application.request('pairs.set_enabled', { id, enabled }),
    remove: (id) => bus.application.request('pairs.delete', { id }),
    syncNow: (id) => bus.application.request('pairs.sync_now', { id }),
    onChanged: (handler) => bus.application.subscribe('pairs.changed', handler),
  };
}

export function fmtBytes(n: number): string {
  if (!n) return '0 B';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

export function fmtAgo(iso: string | null): string {
  if (!iso) return 'never';
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 0 || !Number.isFinite(ms)) return 'just now';
  const s = Math.floor(ms / 1000);
  if (s < 5) return 'just now';
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

export function fmtInterval(ms: number): string {
  if (ms % (60 * 60 * 1000) === 0) {
    const h = ms / (60 * 60 * 1000);
    return h === 1 ? 'every hour' : `every ${h}h`;
  }
  if (ms % (60 * 1000) === 0) return `every ${ms / (60 * 1000)}m`;
  return `every ${Math.round(ms / 1000)}s`;
}
