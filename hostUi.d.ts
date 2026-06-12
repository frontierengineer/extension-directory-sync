// Type shim for `@frontierengineer/ui` — the host's shared UI primitives.
//
// The host bundler aliases `@frontierengineer/ui` to its own frontend tree
// (frontend/src/ui) at build time; the bytes never ship in an extension's
// bundle. A standalone repo has no host tree beside it, so for the local
// typecheck we declare the surface this extension uses. The verify mirror's
// ui tsconfig points the specifier here via `paths`; esbuild marks it external
// (the host resolves it for real at install time), so nothing here is bundled.
// Keep in sync with frontend/src/ui's exports when the ones you import change.
declare module '@frontierengineer/ui' {
  import type { ReactNode } from 'react';

  export interface PreviewClickHandlers {
    onClick: () => void;
    onDoubleClick: () => void;
  }
  export function usePreviewClick(
    openPreview: () => void,
    openPinned: () => void,
  ): PreviewClickHandlers;

  export interface EmptyStateAction {
    label: string;
    onClick: () => void;
  }
  export interface EmptyStateProps {
    icon?: ReactNode;
    title: string;
    description?: ReactNode;
    action?: EmptyStateAction | ReactNode;
  }
  export function EmptyState(props: EmptyStateProps): JSX.Element;
}
