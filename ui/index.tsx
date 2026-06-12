import { createRoot, type Root } from 'react-dom/client';
import type { UiProvider } from '../../types';
import { createClient } from './data';
import { createActions } from './actions';
import { DirSyncView } from './components/DirSyncView';
import { DirSyncSidebar } from './components/DirSyncSidebar';
import './styles.css';

export function register(uiProvider: UiProvider): void {
  const ui = uiProvider.version(1);
  const client = createClient(ui.bus);
  const actions = createActions(ui, client);

  const viewRoots = new Map<HTMLElement, Root>();
  let sidebarRoot: Root | null = null;

  ui.commands.register({
    id: 'dir-sync.open',
    label: 'Directory Sync: Open',
    category: 'Directory Sync',
    run: () => ui.navigate('/dir-sync'),
  });
  ui.commands.register({
    id: 'dir-sync.new',
    label: 'New Sync Pair',
    category: 'Directory Sync',
    run: () => void actions.newPair(),
  });

  ui.views.register({
    id: 'dir-sync',
    tabType: 'dir-sync',
    routes: [{ prefix: '/dir-sync', exact: true }],
    mount(_tabId, container, ctx) {
      ctx.setLabel({ primary: 'Directory Sync' });
      const root = createRoot(container);
      root.render(<DirSyncView client={client} actions={actions} machines={ui.services.machines} />);
      viewRoots.set(container, root);
    },
    unmount(container) {
      viewRoots.get(container)?.unmount();
      viewRoots.delete(container);
    },
  });

  ui.sidebar.register({
    id: 'dir-sync',
    title: 'Directory Sync',
    actions: [{ commandId: 'dir-sync.new', icon: '+', tooltip: 'New Sync Pair' }],
    mount(container) {
      sidebarRoot = createRoot(container);
      sidebarRoot.render(
        <DirSyncSidebar
          client={client}
          actions={actions}
          machines={ui.services.machines}
          navigate={(p, o) => ui.navigate(p, o)}
        />,
      );
    },
    unmount() {
      sidebarRoot?.unmount();
      sidebarRoot = null;
    },
  });

  const refreshBadge = () => {
    client.list()
      .then((pairs) => ui.sidebar.setBadge('dir-sync', pairs.filter((p) => p.status.state === 'error').length || null))
      .catch(() => { /* backend not up yet */ });
  };
  refreshBadge();
  const offChanged = client.onChanged(refreshBadge);
  ui.deregister(() => offChanged());
}
