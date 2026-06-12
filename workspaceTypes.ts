// Workspace / slot / reservation CONTRACT TYPES. See docs/WORKSPACES.md.
//
// Pure types, ZERO runtime + ZERO imports — exactly like protocol.ts. The
// extension contract (extensions/types.ts, re-exported to the frontend) pulls
// the workspace types from HERE, not from workspaces.ts, so the frontend's
// tsc -b never has to compile workspaces.ts's runtime (which imports `crypto`
// and would fail in the frontend's node-type-free build). The runtime —
// OutOfCapacityError + createReservationManager — lives in workspaces.ts and
// re-exports these for the backend's convenience.

// ── Workspace ───────────────────────────────────────────────────────

// A workspace is a PLACE: a machine plus (for directory-backed providers) a
// directory. It says nothing about WHAT runs there — the runtime, model, and
// reasoning depth are SESSION properties, chosen when a session is created on
// a reservation. One workspace serves every runtime; capacity is never split
// by what runs on it.
export interface Workspace {
  id: string;
  title: string;
  machine: string;
  // Workspace-provider id: 'git' | 'mercurial' | 'directory' | 'no-directory' | …
  provider: string;
  // Provider-owned config (e.g. git: { directory }). The core never looks inside.
  config: Record<string, unknown>;
  // Slot cap (capacity). reserve() throws OutOfCapacityError at this many live
  // reservations. Provider defaults/ceilings are enforced by the provider's
  // capacity(); this is the user-set value within those bounds.
  maxSlots: number;
  systemManaged?: boolean;
}

// ── Provider contract ───────────────────────────────────────────────

// What a provider hands back when it prepares a slot: where the turn runs, and
// (for a VCS provider) the branch/commit the reservation sits on.
export interface SlotDescriptor {
  // Absolute working directory for this slot. '' for a no-directory workspace.
  slotDir: string;
  // The workspace's canonical directory ('' when none) — runtimes relate an
  // isolated copy back to the repo with this (e.g. the Claude projects link).
  canonicalDir: string;
  // The reservation's branch, or null when the provider has no VCS.
  branch: string | null;
  // The commit the slot was prepared at, or null when n/a.
  commit: string | null;
  // True when slotDir is an isolated copy (a worktree) rather than the canonical
  // directory itself. Runtimes key their per-slot setup off this.
  isolated: boolean;
}

// Context a provider's begin/end receives for one reservation. `branchKey`
// drives the branch name; `name` is display only.
export interface ReservationProviderContext {
  reservationId: string;
  workspace: Workspace;
  ownerId: string;
  name: string;
  // The owner's branch identity, composed by the manager from what it already
  // knows: `<extensionId>/<ownerSlug || ownerId>`, every segment sanitised to
  // be git-ref-safe. A VCS provider names its branch `frontier/${branchKey}`
  // — "frontier/assistant/triage" in a user's branch list, not an opaque
  // entity id. Stable for the owner's lifetime (slugs are minted once).
  branchKey: string;
  // The slot directories of this workspace's OTHER live reservations, so a
  // pooling provider can pick a free pooled worktree statelessly (any pool
  // dir not in this list is reusable).
  activeSlotDirs: string[];
}

// How a provider's slots are capped — the create/edit UI renders the slot field
// from this, and the manager derives the numeric cap (see slotCapacity in
// workspaces.ts). `fixed` providers ignore the user's value (a plain directory
// is always one slot); `unbounded` is informational (set it as high as you like —
// disk is the only cost). `note` is shown under the field.
export interface SlotPolicy {
  default: number;
  fixed?: boolean;
  unbounded?: boolean;
  note?: string;
}

// A workspace provider owns the working directory + VCS for a kind of workspace.
// begin/end bracket a RESERVATION's life (not each turn). Registered by an
// extension; the core only ever calls these three.
export interface WorkspaceProvider {
  id: string;
  // Prepare a slot: create/select an isolated working dir and (for VCS) check
  // out the reservation's branch where it left off. Must assume nothing about
  // what will run on the slot.
  begin(ctx: ReservationProviderContext): Promise<SlotDescriptor>;
  // Release a slot: (for VCS) commit leftover work as a closure commit, advance
  // the branch, push, then return the worktree to the pool (detached, dir kept
  // for cheap reuse). `keepDirty` skips the closure commit — a human-driven
  // reservation owns its working state. `descriptor` is what begin() returned,
  // so a pooling provider knows WHICH pool dir this reservation held.
  end(ctx: ReservationProviderContext & { keepDirty: boolean; descriptor?: SlotDescriptor }): Promise<void>;
  // How this provider's slots are capped (drives the create/edit UI and the
  // manager's cap check — see slotCapacity in workspaces.ts).
  slots: SlotPolicy;
}

// ── Reservation ─────────────────────────────────────────────────────

export interface Reservation {
  id: string;
  workspaceId: string;
  // Captured from the workspace at reserve time so the host's (synchronous)
  // dispatch adapter can resolve a session's turn to this slot's machine
  // without an async workspace lookup. A reservation knows nothing about
  // runtimes — the session running on it does.
  machine: string;
  // Owner identity, display name, and a back-link to the tab that owns it.
  // Opaque to the manager; the Slots view opens `link`, and a release
  // notifies the owner via onReleased.
  ownerId: string;
  // The owner's stable human slug (→ branch name), minted ONCE by the owning
  // extension when the entity was created. Absent for owners without one —
  // the branch falls back to the opaque ownerId.
  ownerSlug?: string;
  // The extension that made the reservation — where the release signal is
  // delivered (`reservation.released` on that extension's own bus channel).
  extensionId?: string;
  name: string;
  link?: string;
  // Whether end() leaves the working tree as the user left it (true, for
  // human-driven reservations) or runs the provider's closure commit (false).
  keepDirty: boolean;
  // The slot the provider prepared, available once reserve() resolves.
  descriptor: SlotDescriptor;
  // Owner-writable display state for the Workspaces view: a short status line
  // (e.g. "scheduled hourly", "reviewing") the owning extension keeps current.
  status?: string;
  // What freeing this slot will DO, set by the owner at reserve time and shown
  // in the Free confirmation ("sets this space to inactive; uncommitted work is
  // committed to its branch"). The owner is also signalled on release.
  freeNote?: string;
  // Schedule ids attached to this reservation (host-maintained via the
  // Scheduler's reservationId link) — a slot with schedules warns before Free.
  scheduleIds?: string[];
  createdAt: string;
}

export interface ReserveOpts {
  workspaceId: string;
  ownerId: string;
  // Stable human slug for the owner — drives the user-visible branch name
  // (`frontier/<extensionId>/<ownerSlug>`). Mint it once when the entity is
  // created (slugified from its name, uniquified among siblings) and never
  // recompute it on rename — the branch must survive the owner's lifetime.
  ownerSlug?: string;
  name: string;
  link?: string;
  keepDirty?: boolean;
  freeNote?: string;
  extensionId?: string;
}

// ── Reservation manager ─────────────────────────────────────────────

export interface ReservationManagerDeps {
  // Resolve a workspace by id (the host's WorkspaceStore).
  getWorkspace(id: string): Promise<Workspace | null>;
  // Resolve the provider for a workspace's `provider` id (the provider registry).
  getProvider(providerId: string): WorkspaceProvider | null;
  // Lifecycle observers (telemetry's capacity grain — TELEMETRY.md §4). All
  // best-effort: a throw never breaks a reserve/release. `info` carries the
  // workspace facts the manager already has in hand (provider id, cap) so an
  // observer needs no async workspace lookup. onReserved fires only for a NEW
  // claim, never the owner-idempotent re-reserve; onOutOfCapacity fires just
  // before reserve() throws OutOfCapacityError — the demand signal.
  onReserved?(reservation: Reservation, info: { provider: string; cap: number; inUse: number }): void;
  onOutOfCapacity?(info: { workspaceId: string; provider: string; machine: string; cap: number }): void;
  // Notify a reservation's owner that it was released (e.g. so spaces flips to
  // inactive). Best-effort — a throw here never breaks the release.
  onReleased?(reservation: Reservation, info?: { provider: string }): void;
  // Durability. A reservation's provider state (the worktree) lives on the
  // worker's disk, so the records must outlive a host restart or a held slot
  // becomes an orphan: capacity silently consumed, no Free action that can run
  // the provider's end(). The host seeds `initial` at boot and `persist` is
  // called with the full live set after every reserve/release.
  initial?: Reservation[];
  persist?(reservations: Reservation[]): void;
}

export interface ReservationManager {
  // Claim a slot. OWNER-IDEMPOTENT: an owner holds at most one reservation per
  // workspace — re-reserving returns the existing one (same slot + worktree, no
  // provider.begin()), refreshing its display name/link. Throws
  // OutOfCapacityError when a NEW slot would exceed the workspace's cap.
  reserve(opts: ReserveOpts): Promise<Reservation>;
  get(id: string): Reservation | null;
  list(opts?: { workspaceId?: string }): Reservation[];
  // Run the provider's end(), then notify the owner. Idempotent (releasing a
  // gone reservation is a no-op).
  release(id: string): Promise<void>;
  // The owner's explicit teardown: release every reservation this owner holds
  // (deleting a chat/space releases its slot even when no live session handle
  // survives to do it).
  releaseByOwner(ownerId: string): Promise<void>;
  // Owner-writable annotations (status line, display name, link, freeNote) on
  // every reservation the owner holds — how a slot row stays honest about what
  // is happening on it.
  updateByOwner(ownerId: string, patch: { status?: string; name?: string; link?: string; freeNote?: string }): void;
  // Host-side schedule attachment (wired from the Scheduler's reservationId
  // link): a slot knows which schedules depend on it.
  attachSchedule(reservationId: string, scheduleId: string): void;
  detachSchedule(reservationId: string, scheduleId: string): void;
  // Live reservations on a workspace right now.
  inUse(workspaceId: string): number;
}
