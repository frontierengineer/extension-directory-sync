import { useCallback, useEffect, useState } from 'react';
import { usePreviewClick } from '@frontierengineer/ui';
import type { MachineRegistry } from '../../../types';
import type { PairWithStatus } from '../../messages';
import type { DirSyncClient } from '../data';
import type { DirSyncActions } from '../actions';
import { describeStatus, useMachineWarmup } from './DirSyncView';

function lastSegment(dir: string): string {
  return dir.split('/').filter(Boolean).pop() || '/';
}

export function DirSyncSidebar({ client, actions, machines, navigate }: {
  client: DirSyncClient;
  actions: DirSyncActions;
  machines: MachineRegistry;
  navigate: (path: string, opts?: { preview?: boolean }) => void;
}) {
  const [pairs, setPairs] = useState<PairWithStatus[]>([]);

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
    const t = setInterval(load, 30_000);
    return () => clearInterval(t);
  }, [load]);

  return (
    <div className="dirsync-sidebar">
      {pairs.length === 0 ? (
        <div className="dirsync-sidebar-empty">No sync pairs yet. Use + to create one.</div>
      ) : (
        pairs.map((pair) => <SidebarRow key={pair.id} pair={pair} actions={actions} navigate={navigate} />)
      )}
    </div>
  );
}

function SidebarRow({ pair, actions, navigate }: {
  pair: PairWithStatus;
  actions: DirSyncActions;
  navigate: (path: string, opts?: { preview?: boolean }) => void;
}) {
  const { dot, text } = describeStatus(pair);
  const { onClick, onDoubleClick } = usePreviewClick(
    () => navigate('/dir-sync', { preview: true }),
    () => navigate('/dir-sync'),
  );
  const srcName = actions.machineName(pair.source.machine);
  const tgtName = actions.machineName(pair.target.machine);
  return (
    <div
      className={`dirsync-sidebar-item${pair.enabled ? '' : ' is-disabled'}`}
      role="button"
      tabIndex={0}
      title={`${srcName}:${pair.source.directory} → ${tgtName}:${pair.target.directory}`}
      onClick={onClick}
      onDoubleClick={onDoubleClick}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); navigate('/dir-sync'); } }}
    >
      <span className="dirsync-sidebar-route">
        {lastSegment(pair.source.directory)} → {lastSegment(pair.target.directory)}
      </span>
      <span className="dirsync-sidebar-meta">
        <span className={`dirsync-dot is-${dot}`} />
        {text}
      </span>
    </div>
  );
}
