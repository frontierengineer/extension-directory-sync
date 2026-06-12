import { useCallback, useEffect, useState } from 'react';
import { EmptyState } from '@frontierengineer/ui';
import type { MachineRegistry } from '../../../types';
import type { PairWithStatus } from '../../messages';
import type { DirSyncClient } from '../data';
import type { DirSyncActions } from '../actions';
import { fmtAgo, fmtBytes, fmtInterval } from '../data';

// The webview's machines snapshot warms asynchronously after mount with no
// event — briefly poll until names resolve so rows don't sit on the
// unknown-machine fallback.
export function useMachineWarmup(machines: MachineRegistry, onWarm: () => void): void {
  useEffect(() => {
    if (machines.list().length > 0) return;
    let polls = 0;
    const t = setInterval(() => {
      polls += 1;
      if (machines.list().length > 0 || polls > 20) {
        clearInterval(t);
        if (machines.list().length > 0) onWarm();
      }
    }, 250);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [machines]);
}

export function describeStatus(pair: PairWithStatus): { dot: string; text: string } {
  const s = pair.status;
  if (pair.running) {
    return s.state === 'transferring'
      ? { dot: 'busy', text: `transferring · ${s.filesCopied} copied · ${fmtBytes(s.bytes)}` }
      : { dot: 'busy', text: 'scanning…' };
  }
  if (s.state === 'error') return { dot: 'error', text: `failed ${fmtAgo(s.lastFinishedAt)}` };
  if (!s.lastFinishedAt) return { dot: pair.enabled ? 'idle' : 'off', text: 'never synced' };
  return {
    dot: pair.enabled ? 'ok' : 'off',
    text: `synced ${fmtAgo(s.lastFinishedAt)} · ${s.filesCopied} copied · ${s.filesDeleted} deleted · ${fmtBytes(s.bytes)}`,
  };
}

export function DirSyncView({ client, actions, machines }: {
  client: DirSyncClient;
  actions: DirSyncActions;
  machines: MachineRegistry;
}) {
  const [pairs, setPairs] = useState<PairWithStatus[] | null>(null);

  const load = useCallback(() => {
    client.list().then(setPairs).catch(() => {});
  }, [client]);

  useEffect(() => {
    load();
    return client.onChanged(load);
  }, [client, load]);
  useEffect(() => machines.watch(load), [machines, load]);
  useMachineWarmup(machines, load);
  useEffect(() => {
    const t = setInterval(() => setPairs((p) => (p ? [...p] : p)), 30_000);
    return () => clearInterval(t);
  }, []);

  if (!pairs) return <div className="dirsync-view" />;

  return (
    <div className="dirsync-view">
      <div className="dirsync-header">
        <div className="dirsync-header-main">
          <h2 className="dirsync-title">Directory Sync</h2>
          <div className="dirsync-subtitle">
            {pairs.length === 0
              ? 'One-way mirrors between directories on your machines'
              : `${pairs.length} ${pairs.length === 1 ? 'pair' : 'pairs'} · each run mirrors its source onto its target`}
          </div>
        </div>
        <div className="dirsync-header-actions">
          <button className="btn-primary" onClick={() => void actions.newPair()}>New pair</button>
        </div>
      </div>
      <div className="dirsync-list">
        {pairs.length === 0 ? (
          <EmptyState
            title="No sync pairs yet"
            description="A pair mirrors one machine's directory onto another (or onto a second directory on the same machine) on an interval, copying changes and deleting what the source no longer has."
            action={{ label: 'New pair', onClick: () => void actions.newPair() }}
          />
        ) : (
          pairs.map((pair) => <PairCard key={pair.id} pair={pair} actions={actions} client={client} />)
        )}
      </div>
    </div>
  );
}

function PairCard({ pair, actions, client }: {
  pair: PairWithStatus;
  actions: DirSyncActions;
  client: DirSyncClient;
}) {
  const s = pair.status;
  const { dot, text } = describeStatus(pair);
  const extras: string[] = [];
  if (s.symlinksSkipped > 0) extras.push(`${s.symlinksSkipped} symlink${s.symlinksSkipped === 1 ? '' : 's'} skipped`);
  if (s.largeFilesSkipped > 0) extras.push(`${s.largeFilesSkipped} large file${s.largeFilesSkipped === 1 ? '' : 's'} skipped`);
  extras.push(pair.enabled ? fmtInterval(pair.intervalMs) : 'paused');

  return (
    <div className={`dirsync-card${pair.enabled ? '' : ' is-disabled'}`}>
      <div className="dirsync-card-top">
        <div className="dirsync-endpoints" title={`${actions.machineName(pair.source.machine)}:${pair.source.directory} → ${actions.machineName(pair.target.machine)}:${pair.target.directory}`}>
          <span className="dirsync-machine">{actions.machineName(pair.source.machine)}</span>
          <span className="dirsync-path">{pair.source.directory}</span>
          <span className="dirsync-arrow">→</span>
          <span className="dirsync-machine">{actions.machineName(pair.target.machine)}</span>
          <span className="dirsync-path">{pair.target.directory}</span>
        </div>
        <div className="dirsync-card-actions">
          <button
            className="btn-secondary btn-sm"
            disabled={pair.running}
            onClick={() => void actions.syncNow(pair)}
          >Sync now</button>
          <button className="btn-secondary btn-sm" onClick={() => void actions.editPair(pair)}>Edit</button>
          <label className="dirsync-enable">
            <input
              type="checkbox"
              checked={pair.enabled}
              onChange={(e) => void client.setEnabled(pair.id, e.target.checked)}
            />
            Enabled
          </label>
          <button
            className="dirsync-delete"
            title="Delete pair"
            aria-label="Delete pair"
            onClick={() => void actions.deletePair(pair)}
          >×</button>
        </div>
      </div>
      <div className="dirsync-status-line">
        <span className={`dirsync-dot is-${dot}`} />
        <span className="dirsync-status-text">{text} · {extras.join(' · ')}</span>
      </div>
      {s.state === 'error' && s.lastError ? (
        <div className="dirsync-error">{s.lastError}</div>
      ) : null}
      {s.warnings.length > 0 ? (
        <details className="dirsync-warnings">
          <summary>{s.warnings.length} warning{s.warnings.length === 1 ? '' : 's'}</summary>
          <ul>
            {s.warnings.map((w, i) => <li key={i}>{w}</li>)}
          </ul>
        </details>
      ) : null}
    </div>
  );
}
