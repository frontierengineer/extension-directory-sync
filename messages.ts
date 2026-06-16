// Shared types for the dir-sync application's bus surface (server ↔ ui) and
// the pair model both halves render. The worker-channel wire protocol lives
// in worker/index.ts (its implementation) and server/index.ts (its driver).

export interface SyncEndpoint {
  // MachineInfo.id — opaque; the UI always renders the machine's NAME.
  machine: string;
  // Absolute path on that machine.
  directory: string;
}

export interface SyncPair {
  id: string;
  source: SyncEndpoint;
  target: SyncEndpoint;
  enabled: boolean;
  intervalMs: number;
  // Path-segment names excluded from both sides of the mirror (never copied
  // from the source, never deleted on the target).
  exclusions: string[];
  createdAt: string;
}

export type SyncState = 'idle' | 'scanning' | 'transferring' | 'error';

export interface SyncStatus {
  state: SyncState;
  // Start of the most recent run (ISO), null before the first run.
  lastRunAt: string | null;
  // End of the most recent completed run (success or error).
  lastFinishedAt: string | null;
  // Counters from the most recent run (live-updating while transferring).
  filesCopied: number;
  filesDeleted: number;
  bytes: number;
  symlinksSkipped: number;
  largeFilesSkipped: number;
  // Per-file warnings from the most recent run (skips, unreadable files), capped.
  warnings: string[];
  lastError: string | null;
}

export interface PairWithStatus extends SyncPair {
  status: SyncStatus;
  running: boolean;
}

// Bus surface (application channel `pairs.*`):
//   request  pairs.list                                  → { pairs: PairWithStatus[] }
//   request  pairs.create  { source, target, intervalMs?, exclusions? } → { pair } | { error }
//   request  pairs.update  { id, source?, target?, intervalMs?, exclusions? } → { pair } | { error }
//   request  pairs.set_enabled { id, enabled }           → { ok } | { error }
//   request  pairs.delete  { id }                        → { ok } | { error }
//   request  pairs.sync_now { id }                       → { ok } | { error }
//   publish  pairs.changed { id }   (any pair or status change — refetch)

export const DEFAULT_INTERVAL_MS = 5 * 60 * 1000;
export const MIN_INTERVAL_MS = 15 * 1000;
export const MAX_INTERVAL_MS = 24 * 60 * 60 * 1000;
export const DEFAULT_EXCLUSIONS = ['.git', 'node_modules', '.frontier-worktrees'];
export const MAX_FILE_BYTES = 512 * 1024 * 1024;

export function initialStatus(): SyncStatus {
  return {
    state: 'idle',
    lastRunAt: null,
    lastFinishedAt: null,
    filesCopied: 0,
    filesDeleted: 0,
    bytes: 0,
    symlinksSkipped: 0,
    largeFilesSkipped: 0,
    warnings: [],
    lastError: null,
  };
}
