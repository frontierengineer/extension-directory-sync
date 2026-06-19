import { createRoot } from 'react-dom/client';
import { ExtensionSidebar, Split } from '@frontierengineer/ui';
import type { UiV1, UiProvider, ExtensionHost } from '../../types';
import { createClient } from './data';
import { createActions } from './actions';
import { DirSyncView } from './components/DirSyncView';
import { DirSyncSidebar } from './components/DirSyncSidebar';
import './styles.css';

// ─────────────────────────────────────────────────────────────────────
// The Directory Sync app (shell-v2). ONE ui.application.register that owns the
// whole content rect: a left rail listing the sync pairs (with a New Sync Pair
// action) and a main pane holding the single dashboard view of all pairs. There
// is no host tab bar and no host sidebar badge — every row drives the one
// dashboard, so the app is a fixed sidebar + view (no per-instance selection).
// The sidebar and view components are re-housed verbatim.
// ─────────────────────────────────────────────────────────────────────

function DirSyncApp({ ui, host }: { ui: UiV1; host: ExtensionHost }) {
  const client = createClient(host.bus);
  const actions = createActions(ui, client);

  const sidebar = (
    <ExtensionSidebar
      header={<div className="dirsync-sidebar-title">Directory Sync</div>}
      footer={
        <button
          className="btn-secondary btn-sm dirsync-new-btn"
          onClick={() => { void actions.newPair(); }}
        >
          New Sync Pair
        </button>
      }
    >
      <DirSyncSidebar
        client={client}
        actions={actions}
        machines={host.machines}
        navigate={() => { /* one dashboard — every row already drives this view */ }}
      />
    </ExtensionSidebar>
  );

  return (
    <div className="dirsync-app">
      <Split
        first={sidebar}
        second={<DirSyncView client={client} actions={actions} machines={host.machines} />}
        initialFirstSize={260}
        minFirstSize={200}
        minSecondSize={420}
        storageKey="dir-sync.split"
      />
    </div>
  );
}

export function register(uiProvider: UiProvider): void {
  const ui = uiProvider.version(1);
  // A controller-realm client for the create command (the app builds its own
  // from host.bus). The two share the server over the bus — both reach the same
  // backend; the server publishes `pairs.changed` so the app stays live.
  const client = createClient(ui.bus);
  const actions = createActions(ui, client);

  ui.commands.register({
    id: 'dir-sync.new',
    label: 'New Sync Pair',
    category: 'Directory Sync',
    group: 'create',
    run: () => void actions.newPair(),
  });

  // ONE app per extension — the whole directory-sync experience lives in here.
  let root: ReturnType<typeof createRoot> | null = null;
  ui.application.register({
    id: 'dir-sync',
    title: 'Directory Sync',
    // Two folders with a sync arrow between them.
    icon: 'M1.5 4.5a1 1 0 0 1 1-1H5l1 1.2h1.5M1.5 4.5v6a1 1 0 0 0 1 1H6M9.5 11.5h4a1 1 0 0 0 1-1v-6l-1-1.2H10M11.5 6.5l2-2-2-2M4.5 8.5l-2 2 2 2',
    color: '#f59e0b',
    mount(host: ExtensionHost) {
      root = createRoot(host.container);
      root.render(<DirSyncApp ui={ui} host={host} />);
      return () => { root?.unmount(); root = null; };
    },
  });
}
