import type { UiV1, PromptField } from '../../types';
import type { PairWithStatus } from '../messages';
import { DEFAULT_EXCLUSIONS } from '../messages';
import type { DirSyncClient, PairInput } from './data';

export interface DirSyncActions {
  newPair(): Promise<void>;
  editPair(pair: PairWithStatus): Promise<void>;
  deletePair(pair: PairWithStatus): Promise<void>;
  syncNow(pair: PairWithStatus): Promise<void>;
  machineName(id: string): string;
}

const MIRROR_WARNING =
  'One-way mirror: each run makes the target directory identical to the source — '
  + 'target files missing from the source are deleted.';

export function createActions(ui: UiV1, client: DirSyncClient): DirSyncActions {
  const machineName = (id: string) => ui.services.machines.get(id)?.name || 'unknown machine';

  // The host confirm modal doubles as the one-button notice for action
  // errors (no native dialogs; a webview overlay can't escape its iframe).
  const notice = (title: string, message: string) =>
    ui.modals.confirm({ title, message, confirmLabel: 'OK', danger: false }).then(() => undefined);

  function machineOptions(): Array<{ value: string; label: string }> {
    return ui.services.machines.list().map((m) => ({
      value: m.id,
      label: m.connected ? m.name : `${m.name} (disconnected)`,
    }));
  }

  function fields(existing?: PairWithStatus): PromptField[] {
    const machines = machineOptions();
    return [
      { key: 'sourceMachine', label: 'Source machine', type: 'select', options: machines, required: true, default: existing?.source.machine },
      { key: 'sourceDirectory', label: 'Source directory', type: 'string', placeholder: '/absolute/path/on/the/machine', required: true, default: existing?.source.directory },
      { key: 'targetMachine', label: 'Target machine', type: 'select', options: machines, required: true, default: existing?.target.machine },
      { key: 'targetDirectory', label: 'Target directory', type: 'string', placeholder: '/absolute/path/on/the/machine', required: true, default: existing?.target.directory },
      { key: 'interval', label: 'Interval (minutes)', type: 'string', default: existing ? String(existing.intervalMs / 60000) : '5' },
      { key: 'exclusions', label: 'Excluded names (comma-separated)', type: 'string', default: (existing?.exclusions || DEFAULT_EXCLUSIONS).join(', ') },
    ];
  }

  function toInput(values: Record<string, string>): PairInput {
    const minutes = parseFloat(values.interval);
    return {
      source: { machine: values.sourceMachine || '', directory: values.sourceDirectory || '' },
      target: { machine: values.targetMachine || '', directory: values.targetDirectory || '' },
      intervalMs: Number.isFinite(minutes) ? Math.round(minutes * 60000) : undefined,
      exclusions: (values.exclusions || '').split(',').map((s) => s.trim()).filter(Boolean),
    };
  }

  // Prompt → submit → on a backend validation error, re-open the prompt with
  // the error in the description and the rejected values prefilled.
  async function promptLoop(opts: {
    title: string;
    submitLabel: string;
    initialFields: PromptField[];
    submit: (input: PairInput) => Promise<{ error?: string }>;
  }): Promise<void> {
    if (ui.services.machines.list().length === 0) {
      await notice('No machines', 'Directory sync runs between connected machines — connect a worker machine first.');
      return;
    }
    let promptFields = opts.initialFields;
    let error: string | null = null;
    for (;;) {
      const values = await ui.modals.prompt({
        title: opts.title,
        description: error ? `${error}\n\n${MIRROR_WARNING}` : MIRROR_WARNING,
        fields: promptFields,
        submitLabel: opts.submitLabel,
      });
      if (!values) return;
      const res = await opts.submit(toInput(values));
      if (!res?.error) return;
      error = res.error;
      promptFields = promptFields.map((f) => ({ ...f, default: values[f.key] ?? f.default }));
    }
  }

  return {
    machineName,

    newPair: () => promptLoop({
      title: 'New sync pair',
      submitLabel: 'Create',
      initialFields: fields(),
      submit: (input) => client.create(input),
    }),

    editPair: (pair) => promptLoop({
      title: 'Edit sync pair',
      submitLabel: 'Save',
      initialFields: fields(pair),
      submit: (input) => client.update(pair.id, input),
    }),

    async deletePair(pair) {
      const ok = await ui.modals.confirm({
        title: 'Delete sync pair',
        message: `Stop mirroring ${machineName(pair.source.machine)}:${pair.source.directory} → `
          + `${machineName(pair.target.machine)}:${pair.target.directory}? `
          + 'Already-synced files stay on the target; only the pair and its history are removed.',
        confirmLabel: 'Delete',
        danger: true,
      });
      if (!ok) return;
      const res = await client.remove(pair.id);
      if (res?.error) await notice('Could not delete pair', res.error);
    },

    async syncNow(pair) {
      const res = await client.syncNow(pair.id);
      if (res?.error) await notice('Could not start sync', res.error);
    },
  };
}
