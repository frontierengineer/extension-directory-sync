// The dir-sync host backend: owns the pair model (application Store), schedules
// runs, and drives the worker-channel protocol that moves bytes. The host never
// touches the files itself — both endpoints' filesystem work happens in this
// application's worker component (worker/index.ts); a cross-machine pair relays
// source → host → target in acked 256KB chunks, a same-machine pair
// short-circuits to one local mirror op on that machine's worker.

import type { ServerProvider, WorkerChannel, Scheduler, Store } from '../../types';
import {
  type SyncPair,
  type SyncEndpoint,
  type SyncStatus,
  type PairWithStatus,
  initialStatus,
  DEFAULT_INTERVAL_MS,
  MIN_INTERVAL_MS,
  MAX_INTERVAL_MS,
  DEFAULT_EXCLUSIONS,
  MAX_FILE_BYTES,
} from '../messages';

const CHUNK_BYTES = 256 * 1024;
const CHUNK_WINDOW = 4;
const HASH_BATCH = 200;
const MAX_WARNINGS = 20;
const REQUEST_TIMEOUT_MS = 60_000;
const SCAN_TIMEOUT_MS = 5 * 60_000;
const MIRROR_TIMEOUT_MS = 30 * 60_000;

interface FileEntry { rel: string; size: number; mtimeMs: number; mode: number }
interface ScanIndex {
  files: Map<string, FileEntry>;
  symlinksSkipped: number;
  largeSkipped: Array<{ rel: string; size: number }>;
}

// A fatal error aborts the whole run (link-level failure: machine gone,
// request timed out). Non-fatal per-file errors become warnings and the run
// moves on to the next file.
class FatalSyncError extends Error {}

function newId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function normalizeDirectory(raw: any): string | null {
  if (typeof raw !== 'string') return null;
  let dir = raw.trim();
  if (!dir.startsWith('/')) return null;
  while (dir.length > 1 && dir.endsWith('/')) dir = dir.slice(0, -1);
  if (dir === '/') return null;
  return dir;
}

function parseExclusions(raw: any): string[] {
  if (!Array.isArray(raw)) return [...DEFAULT_EXCLUSIONS];
  const out: string[] = [];
  for (const e of raw) {
    if (typeof e !== 'string') continue;
    const name = e.trim();
    if (!name || name.includes('/') || name === '.' || name === '..') continue;
    if (!out.includes(name)) out.push(name);
  }
  return out;
}

function isParentOrEqual(a: string, b: string): boolean {
  return a === b || b.startsWith(`${a}/`);
}

export function register(serverProvider: ServerProvider): void {
  const server = serverProvider.version(1);
  const { bus, workers, services } = server;
  const store: Store = services.store;
  const scheduler: Scheduler = services.scheduler;

  const pairs = new Map<string, SyncPair>();
  const statuses = new Map<string, SyncStatus>();
  const running = new Set<string>();
  const scheduled = new Set<string>();

  // ── Worker-channel request layer ──────────────────────────────────
  // One channel (one wired onMessage) per machine; every request carries a
  // unique reqId and resolves on the matching `<op>.res`. Multi-message
  // responses (scan) accumulate via onPartial until `done`.

  interface Pending {
    machine: string;
    resolve: (msg: any) => void;
    reject: (err: Error) => void;
    timer: NodeJS.Timeout;
    onPartial?: (msg: any) => boolean;
  }
  const pending = new Map<string, Pending>();
  const channels = new Map<string, WorkerChannel>();

  function channelFor(machine: string): WorkerChannel {
    let ch = channels.get(machine);
    if (!ch) {
      ch = workers.channel(machine);
      ch.onMessage((msg: any) => {
        const reqId = typeof msg?.reqId === 'string' ? msg.reqId : '';
        const p = pending.get(reqId);
        if (!p) return;
        if (p.onPartial && !p.onPartial(msg)) {
          p.timer.refresh();
          return;
        }
        clearTimeout(p.timer);
        pending.delete(reqId);
        p.resolve(msg);
      });
      channels.set(machine, ch);
    }
    return ch;
  }

  function request(machine: string, msg: Record<string, any>, opts?: {
    timeoutMs?: number;
    onPartial?: (msg: any) => boolean;
  }): Promise<any> {
    return new Promise((resolve, reject) => {
      const reqId = newId('dsr');
      const timeoutMs = opts?.timeoutMs ?? REQUEST_TIMEOUT_MS;
      const timer = setTimeout(() => {
        pending.delete(reqId);
        reject(new FatalSyncError(`${msg.op} timed out after ${Math.round(timeoutMs / 1000)}s`));
      }, timeoutMs);
      pending.set(reqId, { machine, resolve, reject, timer, onPartial: opts?.onPartial });
      try {
        channelFor(machine).send({ ...msg, reqId });
      } catch (err: any) {
        clearTimeout(timer);
        pending.delete(reqId);
        reject(new FatalSyncError(err?.message || String(err)));
      }
    });
  }

  // A machine dropping fails its outstanding requests immediately — the run
  // aborts with a clean error instead of waiting out the timeouts.
  const unwatchMachines = services.machines.watch((event) => {
    if (event.type !== 'disconnected' || !event.machine) return;
    for (const [reqId, p] of Array.from(pending.entries())) {
      if (p.machine !== event.machine) continue;
      clearTimeout(p.timer);
      pending.delete(reqId);
      p.reject(new FatalSyncError(`machine disconnected mid-sync`));
    }
  });

  // ── Persistence + status fan-out ──────────────────────────────────

  async function loadPairs(): Promise<void> {
    for (const key of await store.list('pairs')) {
      const raw = await store.get(key);
      if (!raw) continue;
      try {
        const pair = JSON.parse(raw) as SyncPair;
        if (pair?.id) pairs.set(pair.id, pair);
      } catch { /* unreadable record — skip */ }
    }
    for (const key of await store.list('status')) {
      const raw = await store.get(key);
      if (!raw) continue;
      try {
        const status = JSON.parse(raw) as SyncStatus;
        const id = key.slice('status/'.length);
        if (pairs.has(id)) {
          // A run can't survive the host process — a status stuck mid-run is
          // from a previous process and reads as an interrupted run.
          if (status.state === 'scanning' || status.state === 'transferring') {
            status.state = 'error';
            status.lastError = 'interrupted by a server restart';
          }
          statuses.set(id, status);
        }
      } catch { /* unreadable record — skip */ }
    }
  }

  function statusFor(id: string): SyncStatus {
    let s = statuses.get(id);
    if (!s) {
      s = initialStatus();
      statuses.set(id, s);
    }
    return s;
  }

  async function savePair(pair: SyncPair): Promise<void> {
    await store.put(`pairs/${pair.id}`, JSON.stringify(pair, null, 2));
  }

  async function saveStatus(id: string): Promise<void> {
    const s = statuses.get(id);
    if (s) await store.put(`status/${id}`, JSON.stringify(s, null, 2));
  }

  const publishTimers = new Map<string, NodeJS.Timeout>();
  function publishChanged(id: string): void {
    bus.application.publish('pairs.changed', { id });
  }
  // Mid-run counter updates coalesce to at most ~2 publishes a second.
  function publishThrottled(id: string): void {
    if (publishTimers.has(id)) return;
    publishTimers.set(id, setTimeout(() => {
      publishTimers.delete(id);
      publishChanged(id);
    }, 500));
  }

  async function transition(id: string, patch: Partial<SyncStatus>): Promise<void> {
    Object.assign(statusFor(id), patch);
    await saveStatus(id);
    publishChanged(id);
  }

  // ── Validation ────────────────────────────────────────────────────

  function machineName(id: string): string {
    return services.machines.get(id)?.name || 'unknown machine';
  }

  function parseEndpoint(raw: any): SyncEndpoint | { error: string } {
    const machine = typeof raw?.machine === 'string' ? raw.machine.trim() : '';
    if (!machine) return { error: 'a machine is required for both endpoints' };
    const directory = normalizeDirectory(raw?.directory);
    if (!directory) return { error: 'directories must be absolute paths on the machine (and not /)' };
    return { machine, directory };
  }

  function validatePairShape(source: SyncEndpoint, target: SyncEndpoint): string | null {
    if (source.machine === target.machine) {
      if (isParentOrEqual(target.directory, source.directory)) {
        return 'the target directory contains (or is) the source — a mirror would overwrite its own source';
      }
      if (isParentOrEqual(source.directory, target.directory)) {
        return 'the target directory is inside the source — a mirror would copy into itself';
      }
    }
    return null;
  }

  function parseInterval(raw: any): number {
    const n = typeof raw === 'number' ? raw : DEFAULT_INTERVAL_MS;
    if (!Number.isFinite(n)) return DEFAULT_INTERVAL_MS;
    return Math.min(MAX_INTERVAL_MS, Math.max(MIN_INTERVAL_MS, Math.round(n)));
  }

  // ── Scheduling ────────────────────────────────────────────────────

  function reconcileSchedules(): void {
    const wanted = new Map<string, SyncPair>();
    for (const pair of pairs.values()) {
      if (pair.enabled) wanted.set(`run_${pair.id}`, pair);
    }
    for (const id of Array.from(scheduled)) {
      if (!wanted.has(id)) {
        scheduler.unregister(id);
        scheduled.delete(id);
      }
    }
    for (const [id, pair] of wanted) {
      scheduler.register({
        id,
        schedule: { kind: 'interval', interval: pair.intervalMs },
        handler: () => runPair(pair.id, 'interval'),
      });
      scheduled.add(id);
    }
  }

  // ── The sync engine ───────────────────────────────────────────────

  async function scanMachine(machine: string, root: string, exclusions: string[], allowMissing = false): Promise<ScanIndex> {
    const index: ScanIndex = { files: new Map(), symlinksSkipped: 0, largeSkipped: [] };
    const res = await request(machine, { op: 'scan', root, exclusions, maxFileBytes: MAX_FILE_BYTES, allowMissing }, {
      timeoutMs: SCAN_TIMEOUT_MS,
      onPartial: (msg) => {
        if (Array.isArray(msg.files)) {
          for (const f of msg.files) {
            if (f && typeof f.rel === 'string') index.files.set(f.rel, f);
          }
        }
        // A worker-side scan failure responds { error } with no done flag —
        // complete on either so the error surfaces instead of timing out.
        return msg.done === true || msg.error !== undefined;
      },
    });
    if (res.error) throw new FatalSyncError(`scan of ${root} failed: ${res.error}`);
    index.symlinksSkipped = res.symlinksSkipped || 0;
    index.largeSkipped = Array.isArray(res.largeSkipped) ? res.largeSkipped : [];
    return index;
  }

  function quickMatch(a: FileEntry, b: FileEntry): boolean {
    return a.size === b.size && Math.floor(a.mtimeMs / 1000) === Math.floor(b.mtimeMs / 1000);
  }

  async function copyFile(
    pair: SyncPair,
    file: FileEntry,
    status: SyncStatus,
  ): Promise<void> {
    const writeId = newId('dsw');
    const open = await request(pair.target.machine, {
      op: 'write.open', writeId, root: pair.target.directory, rel: file.rel,
    });
    if (open.error) throw new Error(open.error);
    try {
      const offsets: number[] = [];
      for (let o = 0; o < file.size; o += CHUNK_BYTES) offsets.push(o);
      let cursor = 0;
      let failed: Error | null = null;
      const lanes = Array.from({ length: Math.min(CHUNK_WINDOW, offsets.length) }, async () => {
        while (cursor < offsets.length && !failed) {
          const offset = offsets[cursor++];
          const length = Math.min(CHUNK_BYTES, file.size - offset);
          try {
            const r = await request(pair.source.machine, {
              op: 'read', root: pair.source.directory, rel: file.rel, offset, length,
            });
            if (r.error) throw new Error(r.error);
            if (r.bytes !== length) throw new Error('file changed while it was being copied');
            const w = await request(pair.target.machine, {
              op: 'write.chunk', writeId, offset, dataB64: r.dataB64 || '',
            });
            if (w.error) throw new Error(w.error);
          } catch (err: any) {
            failed = failed || err;
          }
        }
      });
      await Promise.all(lanes);
      if (failed) throw failed;
      const close = await request(pair.target.machine, {
        op: 'write.close', writeId, mtimeMs: file.mtimeMs, mode: file.mode,
      });
      if (close.error) throw new Error(close.error);
      status.filesCopied += 1;
      status.bytes += file.size;
    } catch (err) {
      try { channelFor(pair.target.machine).send({ op: 'write.abort', writeId }); } catch { /* link already down */ }
      throw err;
    }
  }

  function addWarning(status: SyncStatus, text: string): void {
    if (status.warnings.length < MAX_WARNINGS) status.warnings.push(text);
    else if (status.warnings.length === MAX_WARNINGS) status.warnings.push('… more warnings truncated');
  }

  async function relaySync(pair: SyncPair, status: SyncStatus): Promise<void> {
    const [source, target] = await Promise.all([
      scanMachine(pair.source.machine, pair.source.directory, pair.exclusions),
      scanMachine(pair.target.machine, pair.target.directory, pair.exclusions, true),
    ]);
    status.symlinksSkipped = source.symlinksSkipped;
    status.largeFilesSkipped = source.largeSkipped.length;
    for (const skip of source.largeSkipped) {
      addWarning(status, `skipped ${skip.rel} (${fmtBytes(skip.size)} exceeds the ${fmtBytes(MAX_FILE_BYTES)} per-file cap)`);
    }

    const toCopy: FileEntry[] = [];
    const hashCandidates: FileEntry[] = [];
    for (const [rel, src] of source.files) {
      const tgt = target.files.get(rel);
      if (!tgt) toCopy.push(src);
      else if (src.size !== tgt.size) toCopy.push(src);
      else if (!quickMatch(src, tgt)) hashCandidates.push(src);
    }
    const toDelete: string[] = [];
    for (const rel of target.files.keys()) {
      if (!source.files.has(rel)) toDelete.push(rel);
    }

    // Same size, different mtime: hash both sides; copy real differences,
    // re-stamp the target's mtime on matches so the next run quick-skips.
    const toTouch: Array<{ rel: string; mtimeMs: number }> = [];
    for (let i = 0; i < hashCandidates.length; i += HASH_BATCH) {
      const batch = hashCandidates.slice(i, i + HASH_BATCH);
      const rels = batch.map((f) => f.rel);
      const [srcRes, tgtRes] = await Promise.all([
        request(pair.source.machine, { op: 'hash', root: pair.source.directory, rels }, { timeoutMs: SCAN_TIMEOUT_MS }),
        request(pair.target.machine, { op: 'hash', root: pair.target.directory, rels }, { timeoutMs: SCAN_TIMEOUT_MS }),
      ]);
      for (const f of batch) {
        const a = srcRes.hashes?.[f.rel];
        const b = tgtRes.hashes?.[f.rel];
        if (a && b && a === b) toTouch.push({ rel: f.rel, mtimeMs: f.mtimeMs });
        else toCopy.push(f);
      }
    }

    await transition(pair.id, { state: 'transferring' });

    for (const file of toCopy) {
      try {
        await copyFile(pair, file, status);
      } catch (err: any) {
        if (err instanceof FatalSyncError) throw err;
        addWarning(status, `${file.rel}: ${err?.message || err}`);
      }
      publishThrottled(pair.id);
    }

    if (toTouch.length > 0) {
      await request(pair.target.machine, { op: 'touch', root: pair.target.directory, items: toTouch });
    }

    if (toDelete.length > 0) {
      const res = await request(pair.target.machine, { op: 'delete', root: pair.target.directory, rels: toDelete });
      status.filesDeleted += res.deleted || 0;
      for (const e of Array.isArray(res.errors) ? res.errors : []) addWarning(status, String(e));
    }
  }

  async function localSync(pair: SyncPair, status: SyncStatus): Promise<void> {
    await transition(pair.id, { state: 'transferring' });
    const res = await request(pair.source.machine, {
      op: 'mirror',
      sourceRoot: pair.source.directory,
      targetRoot: pair.target.directory,
      exclusions: pair.exclusions,
      maxFileBytes: MAX_FILE_BYTES,
    }, { timeoutMs: MIRROR_TIMEOUT_MS });
    if (res.error) throw new FatalSyncError(res.error);
    status.filesCopied = res.copied || 0;
    status.filesDeleted = res.deleted || 0;
    status.bytes = res.bytes || 0;
    status.symlinksSkipped = res.symlinksSkipped || 0;
    status.largeFilesSkipped = Array.isArray(res.largeSkipped) ? res.largeSkipped.length : 0;
    for (const skip of Array.isArray(res.largeSkipped) ? res.largeSkipped : []) {
      addWarning(status, `skipped ${skip.rel} (${fmtBytes(skip.size)} exceeds the ${fmtBytes(MAX_FILE_BYTES)} per-file cap)`);
    }
    for (const w of Array.isArray(res.warnings) ? res.warnings : []) addWarning(status, String(w));
  }

  async function runPair(pairId: string, trigger: 'interval' | 'manual'): Promise<void> {
    const pair = pairs.get(pairId);
    if (!pair || running.has(pairId)) return;
    running.add(pairId);
    const startedAt = new Date().toISOString();
    const status = statusFor(pairId);
    Object.assign(status, {
      state: 'scanning' as const,
      lastRunAt: startedAt,
      filesCopied: 0,
      filesDeleted: 0,
      bytes: 0,
      symlinksSkipped: 0,
      largeFilesSkipped: 0,
      warnings: [],
      lastError: null,
    });
    try {
      await saveStatus(pairId);
      publishChanged(pairId);

      const shapeError = validatePairShape(pair.source, pair.target);
      if (shapeError) throw new FatalSyncError(shapeError);
      for (const end of [pair.source, pair.target]) {
        if (!channelFor(end.machine).connected()) {
          throw new FatalSyncError(`machine "${machineName(end.machine)}" is not connected`);
        }
      }

      if (pair.source.machine === pair.target.machine) await localSync(pair, status);
      else await relaySync(pair, status);

      await transition(pairId, { state: 'idle', lastFinishedAt: new Date().toISOString() });
      console.log(
        `[dir-sync] ${trigger} run ${pairId}: copied ${status.filesCopied} (${fmtBytes(status.bytes)}), ` +
        `deleted ${status.filesDeleted}` +
        (status.warnings.length ? `, ${status.warnings.length} warning(s)` : ''),
      );
    } catch (err: any) {
      await transition(pairId, {
        state: 'error',
        lastError: err?.message || String(err),
        lastFinishedAt: new Date().toISOString(),
      }).catch(() => { /* status persistence is best-effort on the error path */ });
      console.error(`[dir-sync] ${trigger} run ${pairId} failed: ${err?.message || err}`);
    } finally {
      running.delete(pairId);
    }
  }

  // ── Bus responders (this application's UI) ────────────────────────

  bus.application.respond('pairs.list', async (): Promise<{ pairs: PairWithStatus[] }> => {
    const list = Array.from(pairs.values())
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .map((pair) => ({ ...pair, status: statusFor(pair.id), running: running.has(pair.id) }));
    return { pairs: list };
  });

  bus.application.respond('pairs.create', async (params: any) => {
    const source = parseEndpoint(params?.source);
    if ('error' in source) return { error: `source: ${source.error}` };
    const target = parseEndpoint(params?.target);
    if ('error' in target) return { error: `target: ${target.error}` };
    const shapeError = validatePairShape(source, target);
    if (shapeError) return { error: shapeError };
    const pair: SyncPair = {
      id: newId('pair'),
      source,
      target,
      enabled: true,
      intervalMs: parseInterval(params?.intervalMs),
      exclusions: parseExclusions(params?.exclusions),
      createdAt: new Date().toISOString(),
    };
    pairs.set(pair.id, pair);
    statuses.set(pair.id, initialStatus());
    await savePair(pair);
    await saveStatus(pair.id);
    reconcileSchedules();
    publishChanged(pair.id);
    return { pair };
  });

  bus.application.respond('pairs.update', async (params: any) => {
    const pair = pairs.get(String(params?.id || ''));
    if (!pair) return { error: 'unknown pair' };
    if (running.has(pair.id)) return { error: 'this pair is mid-sync — wait for the run to finish' };
    const source = params?.source !== undefined ? parseEndpoint(params.source) : pair.source;
    if ('error' in source) return { error: `source: ${source.error}` };
    const target = params?.target !== undefined ? parseEndpoint(params.target) : pair.target;
    if ('error' in target) return { error: `target: ${target.error}` };
    const shapeError = validatePairShape(source, target);
    if (shapeError) return { error: shapeError };
    pair.source = source;
    pair.target = target;
    if (params?.intervalMs !== undefined) pair.intervalMs = parseInterval(params.intervalMs);
    if (params?.exclusions !== undefined) pair.exclusions = parseExclusions(params.exclusions);
    await savePair(pair);
    reconcileSchedules();
    publishChanged(pair.id);
    return { pair };
  });

  bus.application.respond('pairs.set_enabled', async (params: any) => {
    const pair = pairs.get(String(params?.id || ''));
    if (!pair) return { error: 'unknown pair' };
    pair.enabled = params?.enabled === true;
    await savePair(pair);
    reconcileSchedules();
    publishChanged(pair.id);
    return { ok: true };
  });

  bus.application.respond('pairs.delete', async (params: any) => {
    const id = String(params?.id || '');
    const pair = pairs.get(id);
    if (!pair) return { error: 'unknown pair' };
    if (running.has(id)) return { error: 'this pair is mid-sync — wait for the run to finish' };
    pairs.delete(id);
    statuses.delete(id);
    await store.delete(`pairs/${id}`);
    await store.delete(`status/${id}`);
    reconcileSchedules();
    publishChanged(id);
    return { ok: true };
  });

  bus.application.respond('pairs.sync_now', async (params: any) => {
    const id = String(params?.id || '');
    if (!pairs.has(id)) return { error: 'unknown pair' };
    if (running.has(id)) return { error: 'a sync is already in progress for this pair' };
    void runPair(id, 'manual');
    return { ok: true };
  });

  void loadPairs().then(() => {
    reconcileSchedules();
    console.log(`[dir-sync] loaded ${pairs.size} pair(s)`);
  });

  server.deregister(() => {
    unwatchMachines();
    for (const id of Array.from(scheduled)) scheduler.unregister(id);
    scheduled.clear();
    for (const t of publishTimers.values()) clearTimeout(t);
    publishTimers.clear();
    for (const [reqId, p] of Array.from(pending.entries())) {
      clearTimeout(p.timer);
      pending.delete(reqId);
      p.reject(new FatalSyncError('application unloading'));
    }
  });
}
