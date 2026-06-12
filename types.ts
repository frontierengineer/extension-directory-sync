// ─────────────────────────────────────────────────────────────────────────
// VENDORED HOST CONTRACT — do not edit by hand.
//
// This is a verbatim copy of the Frontier host's extension contract
// (frontier/server/backend/extensions/types.ts). Every capability imports it
// as `../../types` — and from any capability dir that specifier resolves to
// THIS file at the extension root:
//
//   <ext>/server/index.ts  →  ../../types  →  <ext>/types.ts   ✓
//   <ext>/ui/index.tsx      →  ../../types  →  <ext>/types.ts   ✓
//   <ext>/worker/index.ts   →  ../../types  →  <ext>/types.ts   ✓
//
// Why it's checked into a STANDALONE extension repo: when the host installs an
// extension it copies the extension into <FRONTIER_DIR>/extensions/<id>/ and
// writes an equivalent `types.ts` one level up, so `../../types` resolves the
// same way in production. This repo has no host beside it, so we vendor the
// contract here — the extension then typechecks against the EXACT host shape,
// and `import type` lines are type-only (esbuild erases them from the
// ui/worker bundles, so nothing ships at runtime). See README → "How types
// resolve". Keep this in sync with the host by re-copying when the API moves.
// ─────────────────────────────────────────────────────────────────────────

/// <reference lib="dom" />
// FrontierUI's contribution types below type the mount container as a DOM
// HTMLElement. The host frontend has the DOM lib; the server typecheck
// (tsconfig lib: ES2022, no DOM) does not — declare the dependency here so
// `tsc --noEmit` over backend/ resolves HTMLElement deterministically
// instead of leaning on DOM-referencing @types from a parent node_modules.

import type { WorkspaceProvider, Workspace, Reservation } from './workspaceTypes';

// ── Bus ─────────────────────────────────────────────────────────────

// The bus an extension sees: ITS OWN channel plus the public cross-extension
// surface. There is deliberately no core channel here — core functionality
// reaches an extension only as a typed service (services.workspaces,
// services.sessions, …). The services ride host-owned wire types internally;
// that wire is not extension API.
export interface Bus {
  // The extension's OWN private channel (ext.<id>.*). Full
  // publish/subscribe/request/respond — UI ↔ this extension's backend.
  extension: BusChannel;

  // This extension's PUBLIC, versioned endpoints. What is registered here
  // (and only this) is what OTHER extensions can reach via
  // `bus.extensions(thisId)`. Lives in the extension's own namespace; the
  // host tracks it in a per-extension public registry.
  public: PublicBusChannel;

  // A READ-ONLY public view of ANOTHER extension's endpoints. Exposes only
  // request/subscribe (no publish/respond), so an extension can neither
  // emit on nor hijack another extension's namespace. Versions resolve to
  // the requested one, else the highest non-deprecated registered version.
  extensions(extensionId: string): PublicView;
}

export interface BusChannel {
  publish(type: string, payload?: any): void;
  subscribe(type: string, handler: (payload: any) => void): () => void;
  // `timeoutMs` overrides the default request timeout for THIS call only —
  // for a responder whose work is legitimately slow (e.g. a cold-start
  // model load). Omit it and you get the default. Backward-compatible:
  // existing callers pass nothing.
  request<T = any>(type: string, payload?: any, opts?: { timeoutMs?: number }): Promise<T>;
  respond(type: string, handler: (payload: any) => any | Promise<any>): void;
}

// The core channel. Same shape as BusChannel but request/respond/publish/
// subscribe accept an OPTIONAL version. Omitting it targets the bare,
// unversioned wire name — so existing unversioned core calls
// (bus.core.request('machines.list', {})) keep working unchanged.
// request() also accepts a per-call `timeoutMs` override (see BusChannel).
export interface CoreChannel {
  publish(type: string, payload?: any, opts?: { version?: number }): void;
  subscribe(type: string, handler: (payload: any) => void, opts?: { version?: number }): () => void;
  request<T = any>(type: string, payload?: any, opts?: { version?: number; timeoutMs?: number }): Promise<T>;
  respond(type: string, handler: (payload: any) => any | Promise<any>, opts?: { version?: number }): void;
}

// Registration surface for an extension's OWN public, versioned endpoints.
export interface PublicBusChannel {
  // Register a public, versioned responder. v1 can stay live while v2
  // ships; mark the old one deprecated via deprecate() when ready.
  respond(topic: string, version: number, handler: (payload: any) => any | Promise<any>): void;
  // Emit a public, versioned event other extensions can subscribe to.
  publish(topic: string, version: number, payload?: any): void;
  // Subscribe to this extension's own public event (completeness / same-
  // side wiring). Returns an unsubscribe fn.
  subscribe(topic: string, version: number, handler: (payload: any) => void): () => void;
  // Mark a public endpoint deprecated. Using it (cross-call or publish)
  // logs a loud one-time banner. The endpoint still works.
  deprecate(topic: string, version: number, message?: string): void;
}

// READ-ONLY view of another extension's public endpoints.
export interface PublicView {
  // Resolve the target's public responder for `topic` (exact `version` if
  // given, else the highest non-deprecated registered version). Rejects if
  // none is registered. A deprecated version still works (logs a banner).
  // `timeoutMs` overrides the default request timeout for this call only.
  request<T = any>(topic: string, payload?: any, opts?: { version?: number; timeoutMs?: number }): Promise<T>;
  // Subscribe to the target's public events. Returns an unsubscribe fn.
  subscribe(topic: string, handler: (payload: any) => void, opts?: { version?: number }): () => void;
}

// ── Store ───────────────────────────────────────────────────────────
//
// A flat, per-extension key/value store backing the extension's durable
// state. Each extension gets its own private namespace on disk
// (extensions/<id>/data/) — keys never collide across extensions. Keys
// are slash-delimited paths (`[a-z0-9_]` segments, dots allowed after the
// first) that map to files, so a `/` in a key creates a subdirectory:
// `list(prefix)` therefore behaves like a recursive directory walk.

export interface Store {
  // Returns null when the key is absent (never throws on miss).
  get(key: string): Promise<string | null>;
  put(key: string, value: string): Promise<void>;
  // Binary variants for blobs (images, meeting audio). Same keyspace as get/put.
  // Typed as Uint8Array, not Node's Buffer, so the contract carries no Node type
  // across the boundary: the fs backend's Buffer IS a Uint8Array (passes through
  // unchanged), and the browser hands one in directly — no casts on either side.
  getBytes(key: string): Promise<Uint8Array | null>;
  putBytes(key: string, value: Uint8Array): Promise<void>;
  // Idempotent — deleting a missing key is a no-op, not an error.
  delete(key: string): Promise<void>;
  // All keys at or under `prefix`, sorted. Recurses into subkeys; the
  // returned strings are full keys (prefix included), not relative.
  list(prefix: string): Promise<string[]>;
  rename(oldKey: string, newKey: string): Promise<void>;
  // React to changes: `handler` fires whenever any key at or under `prefix`
  // is written, deleted or renamed — including by another open instance of
  // the extension. Returns an unsubscribe fn. This is how a view stays live
  // without polling.
  watch(prefix: string, handler: () => void): () => void;
}

// ── Config ──────────────────────────────────────────────────────────
//
// User-editable settings for an extension. `declare` describes a key (its
// type, label, default, constraints) so the host can render an editor for
// it in the settings UI; `get` reads the current value; `watch` reacts to
// edits live. Values persist in extensions/<id>/config.json.

// A single config key's schema. The `type` drives which editor widget the
// host renders and constrains the value's shape (`number` adds min/max,
// `select` an enumerated option list, `color` a swatch picker). `label` is
// the UI heading; `description` the help text under it; `default` the value
// `get` returns until the user overrides it.
export type ConfigDeclaration =
  | { key: string; label: string; description?: string; type: 'string'; default?: string }
  | { key: string; label: string; description?: string; type: 'number'; default?: number; min?: number; max?: number }
  | { key: string; label: string; description?: string; type: 'boolean'; default?: boolean }
  | { key: string; label: string; description?: string; type: 'color'; default?: string }
  | { key: string; label: string; description?: string; type: 'select'; default?: string; options: Array<{ value: string; label: string }> };

export interface Config {
  declare(decl: ConfigDeclaration): void;
  // Every declaration registered so far (a snapshot, in declaration order).
  // The host enumerates these to render a settings editor for the extension.
  declarations(): ConfigDeclaration[];
  // Current value, else the declared `default`, else undefined. Reading an
  // undeclared key (or one with no default and no stored value) yields
  // undefined — there is no throw-on-missing.
  get<T = any>(key: string): T | undefined;
  // Fires on every edit to `key` (also on programmatic setValue), not on
  // the initial value. Returns an unsubscribe fn.
  watch(key: string, handler: (value: any) => void): () => void;
}

// ── Machines ────────────────────────────────────────────────────────
//
// Read-only view (plus a remote-exec primitive) over the worker machines
// the host knows about. A "machine" is a worker daemon. This is a live
// snapshot derived from worker connections.

export interface MachineInfo {
  // Stable identifier and on-disk directory name (machines/<id>/) — keep it
  // for keying, but never show it in the UI (it's an opaque uuid).
  id: string;
  // Human display name (the configured title, else the host, else the id as a
  // last resort). This is what the UI shows.
  name: string;
  // Whether the worker daemon's socket is currently open. Goes false the
  // moment the worker drops; its workspaces are unreachable until it returns.
  connected: boolean;
}

export type MachineEvent =
  | { type: 'connected'; machine: string }
  | { type: 'disconnected'; machine: string }
  // A slot's busy state may have flipped (an execution started or finished
  // against the reservation).
  | { type: 'reservation.status'; machine?: string; reservationId: string; status: 'idle' | 'busy' };

export interface MachineExecOptions {
  // The binary to run, e.g. "git", "free", "node". Resolved on the
  // worker's PATH. No shell is involved — args are passed directly,
  // so there's no quoting/interpolation to worry about.
  command: string;
  // Argument vector. Each element is one argv slot.
  args?: string[];
  // Working directory on the worker. Defaults to the worker's home
  // when omitted.
  cwd?: string;
}

export interface ExecResult {
  // True iff the process ran to completion AND exited 0. A non-zero exit
  // or a transport failure (worker gone, spawn error) both give ok=false,
  // so callers can branch on this one flag.
  ok: boolean;
  stdout: string;
  stderr: string;
  // The process exit code. Absent when the command never produced one —
  // i.e. it couldn't be launched / the RPC failed (see `error`).
  exitCode?: number;
  // Transport/launch failure message (worker disconnected, binary not
  // found, etc.). Set only when the process didn't run normally; a normal
  // non-zero exit reports via exitCode/stderr, not here.
  error?: string;
}

export interface MachineRegistry {
  // Snapshot of all known machines. Synchronous — reads cached heartbeat
  // state, no round-trip to the workers.
  list(): MachineInfo[];
  get(id: string): MachineInfo | null;
  // Subscribe to fleet changes (connect/disconnect/slot status). Returns
  // an unsubscribe fn.
  watch(handler: (event: MachineEvent) => void): () => void;

  // Run a process on a connected worker machine (an RPC to the worker
  // daemon). This is a generic primitive — nothing attaches meaning to
  // what you run. An extension might invoke a VCS binary, probe memory
  // pressure before a heavy dispatch, lint a directory, or anything else.
  exec(machine: string, opts: MachineExecOptions): Promise<ExecResult>;
}

// ── Filesystem ──────────────────────────────────────────────────────
//
// Read and write a SLOT's files. Every call is scoped to a reservation —
// file access happens through a slot (docs/WORKSPACES.md §6); get one
// from `reservation.list` on the core bus or your own session's targetId.
// Paths are slot-relative with a leading slash. Each op resolves to a
// result object with `ok`; on failure `ok` is false and `error` is set
// (a call never rejects for a normal filesystem error).

export type FsKind = 'file' | 'dir' | 'symlink' | 'other';

export interface FsListEntry {
  name: string;
  kind: FsKind;
  size?: number;
  mtime: number;
  symlink_target?: string;
}
export interface FsResultErr { ok: false; error: string; code?: string }
export type FsListResult =
  | { ok: true; path: string; entries: FsListEntry[]; truncated?: boolean; total_entries?: number }
  | FsResultErr;
export type FsReadResult =
  | { ok: true; path: string; encoding: 'utf-8' | 'base64'; content: string; size: number; lines: number; mtime: number; truncated_at?: number }
  | FsResultErr;
export interface FsListRecursiveEntry { path: string; name: string; kind: FsKind; size?: number; mtime: number }
export type FsListRecursiveResult =
  | { ok: true; path: string; entries: FsListRecursiveEntry[]; truncated?: boolean; max_depth: number; max_entries: number }
  | FsResultErr;
export type FsStatResult =
  | { ok: true; path: string; kind: FsKind; size: number; mtime: number; ctime: number; mode: number; symlink_target?: string }
  | FsResultErr;

export interface Fs {
  list(reservationId: string, path: string, opts?: { show_hidden?: boolean }): Promise<FsListResult>;
  read(reservationId: string, path: string): Promise<FsReadResult>;
  write(reservationId: string, path: string, content: string): Promise<{ ok: boolean; error?: string }>;
  stat(reservationId: string, path: string): Promise<FsStatResult>;
  listRecursive(reservationId: string, path?: string, opts?: { max_depth?: number; max_entries?: number; show_hidden?: boolean }): Promise<FsListRecursiveResult>;
}

// ── Http ────────────────────────────────────────────────────────────
//
// Host-mediated outbound fetch — the only network path exposed to extension
// code. Every call is checked against the extension's declared+granted host
// allowlist AND an unconditional SSRF guard (internal/non-routable addresses
// are always refused, https-only, redirects re-validated per hop). The host
// performs the actual request; UI calls ride the bus to the same guard. See
// http.ts and the manifest `network` block.

export interface HttpFetchOpts {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD';
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
  // 'text' (default) decodes the body as utf-8; 'bytes' returns it base64-encoded
  // (for binary downloads — images, ROMs, archives). Decode with
  // `Buffer.from(res.body, 'base64')` host-side or `atob` in the browser.
  responseType?: 'text' | 'bytes';
}
export interface HttpResponse {
  status: number;
  headers: Record<string, string>;
  // utf-8 text, or base64 when the request asked for `responseType: 'bytes'`.
  body: string;
  encoding: 'utf-8' | 'base64';
  // Final URL after any followed (re-validated) redirects.
  url: string;
}
export interface Http {
  fetch(url: string, opts?: HttpFetchOpts): Promise<HttpResponse>;
}

// ── Voice ───────────────────────────────────────────────────────────
//
// Speech-to-text and text-to-speech. `transcribe` takes base64-encoded
// audio (with its content type) and returns the recognised text, plus
// per-speaker segments when a diarizing engine is configured. `synthesize`
// takes text and returns base64 audio + its content type. Either reports
// `ok: false` with `error` when the host has no STT/TTS engine wired.
//
// `priority` marks how the STT engine should queue the clip when it is
// busy: 'realtime' (someone is waiting on the result mid-conversation —
// jump ahead of batch work) vs 'batch' (the default — background
// transcription like meeting capture, FIFO).

export interface Voice {
  transcribe(audio: { base64: string; contentType: string; priority?: 'realtime' | 'batch' }): Promise<{
    ok: boolean;
    text?: string;
    segments?: Array<{ speaker?: string; start?: number; end?: number; text: string }>;
    error?: string;
  }>;
  synthesize(text: string, opts?: { voice?: string }): Promise<{
    ok: boolean;
    base64?: string;
    contentType?: string;
    error?: string;
  }>;
  // Whether each engine is actually USABLE right now — a build can expose
  // this service while running without a TTS engine, and a voice UI should
  // degrade to text quietly instead of erroring on every reply. Optional so
  // older hosts keep working; callers assume available when absent.
  status?(): Promise<{ stt: boolean; tts: boolean }>;
}

// ── Workspaces (WHERE work runs) ────────────────────────────────────
//
// Places and their capacity. A workspace is a place (machine + directory);
// a reservation claims one of its slots. Reservations are INDEPENDENT of
// sessions — an extension may reserve a slot and never run a session on it
// (inspect a worktree, drop in and commit something, hold capacity for a
// schedule). Releasing is the owner's explicit act; the host signals it as
// `reservation.released` on the owning extension's own bus channel.
export interface Workspaces {
  // Places a reservation can be made against.
  list(): Promise<Workspace[]>;
  // Live reservations (slots), optionally filtered. Each carries a live
  // `busy` flag — in-flight is a property of the slot.
  reservations(filter?: { ownerId?: string; workspaceId?: string }): Promise<Reservation[]>;
  // Claim a slot. OWNER-IDEMPOTENT: an owner holds at most one reservation
  // per workspace — re-reserving returns the existing one. Throws when the
  // workspace is at capacity.
  // `ownerSlug` is the owner's stable HUMAN name for the branch: the host
  // composes `frontier/<your extension id>/<ownerSlug>` so the branch a user
  // sees reads "frontier/assistant/triage", never an opaque entity id. Mint
  // the slug ONCE when the entity is created (slugify its name, uniquify
  // among siblings) and never recompute it on rename — the branch must be
  // stable for the owner's lifetime. Omitted: the opaque ownerId is used.
  reserve(opts: { workspaceId: string; ownerId: string; ownerSlug?: string; name: string; link?: string; freeNote?: string; keepDirty?: boolean }): Promise<Reservation>;
  // Release one slot (runs the provider's closure; idempotent).
  release(reservationId: string): Promise<void>;
  // The owner's explicit teardown: release every reservation `ownerId` holds.
  releaseByOwner(ownerId: string): Promise<void>;
  // Owner-writable slot annotations (status line, name, link, freeNote).
  update(ownerId: string, patch: { status?: string; name?: string; link?: string; freeNote?: string }): Promise<void>;
}

// ── Runtimes (WHAT runs) ────────────────────────────────────────────
//
// A runtime extension declares itself (and the options its sessions accept)
// in its extension.json `runtime` block; the host surfaces the installed set
// here. Options are DECLARATIVE so a session creator renders any runtime's
// knobs without knowing its vocabulary.
export interface RuntimeInfo {
  // The runtime extension's id — the value sessions.create({ runtime }) takes.
  id: string;
  // Human display name (falls back to the id).
  label: string;
  // The options this runtime's sessions accept, in render order. Keys map
  // onto sessions.create fields ('model', 'reasoningEffort').
  options: RuntimeOptionDecl[];
}

export interface RuntimeOptionDecl {
  key: 'model' | 'reasoningEffort';
  label: string;
  // 'text' renders a free input (with optional suggestions); 'select' a
  // fixed choice list. An empty value means "runtime default".
  type: 'text' | 'select';
  choices?: Array<{ value: string; label: string }>;
  suggestions?: string[];
  placeholder?: string;
  description?: string;
}

// ── Personas ────────────────────────────────────────────────────────
//
// A global, reusable system-prompt preamble the session creator picks at
// create() time. The chosen persona's `prompt` is prepended to the dispatch
// system prompt every turn (resolved per turn, so edits take effect), giving
// the agent a consistent voice/role across sessions without each extension
// hard-coding it.
export interface Persona {
  id: string;
  name: string;
  // The preamble text prepended to the session's system prompt.
  prompt: string;
  createdAt: string;
}

// ── Skills ──────────────────────────────────────────────────────────
//
// A named, retrievable instruction-set (a runbook). Unlike a persona (a
// voice/role preamble prepended every turn), a skill is pulled on demand:
// the host exposes a `frontier.skills_search` MCP tool to every session so
// an agent can fetch a relevant runbook's body mid-task. The body is plain
// markdown/text the user authors in Settings → Skills.
export interface Skill {
  id: string;
  name: string;
  // The instruction-set body returned to an agent that searches for it.
  body: string;
  createdAt: string;
}

// ── Sessions ────────────────────────────────────────────────────────
//
// An extension-owned conversation with a worker agent. A session is bound
// to a reservation (its slot) at creation; each `dispatch` sends one turn
// to that slot (queuing while a turn is already in flight there).
// Sessions are in-memory/ephemeral here — durability comes from
// `providerSessionId` (the worker-side conversation), which an extension
// persists itself and replays into create() after a restart.

export interface Sessions {
  // `providerSessionId` seeds continuity: pass a prior provider session id to
  // resume that conversation (the next dispatch sends it to the worker as the
  // resume handle). Used to re-attach a durable conversation to a fresh
  // in-memory session after a server restart, since host session ids are
  // ephemeral while the provider session id is the durable, on-disk identity.
  // `personaId` names a global persona whose `prompt` is prepended to every
  // turn's system prompt (resolved per turn, so persona edits take effect);
  // omit for none. `personaPrompt` is a raw inline preamble (a one-off persona
  // an extension types itself, not in the catalogue) used verbatim each turn;
  // it takes precedence over `personaId` when both are given.
  // Pass `workspaceId` (+ optional `ownerId`, a stable id, e.g. a space id;
  // plus `ownerSlug`, the owner's stable human name — the host derives the
  // branch as `frontier/<extension>/<slug>`) to reserve a slot for the session.
  // Reserving is OWNER-IDEMPOTENT: the same owner gets its existing slot back
  // (same worktree) rather than consuming another. `link` is the owner's tab
  // path — the Workspaces view opens it from the slot row. `freeNote` is shown
  // in the Free confirmation: one sentence on what freeing the slot will DO to
  // this owner ("sets the space to inactive; uncommitted work is committed to
  // its branch").
  // WHERE: pass `reservationId` to run on a slot you (or another flow)
  // already reserved — the session runs there but does NOT own the
  // reservation (deleting the session leaves it held; the reserver
  // releases it). Or pass `workspaceId` (+ `ownerId`) as the common-case
  // convenience: the host reserves owner-idempotently and the session owns
  // that reservation (deleted with it).
  // WHAT: `runtime` names the runtime extension that executes the turns
  // ('claude-code', 'opencode', …); omit for the host default. `model` /
  // `reasoningEffort` are runtime options (declared by the runtime — see
  // listRuntimes), carried verbatim for EVERY turn; omit for the runtime's
  // defaults. A live conversational session (e.g. the assistant's voice
  // loop) wants effort 'low' — time-to-first-word beats reasoning depth.
  create(opts: { reservationId?: string; workspaceId?: string; ownerId?: string; ownerSlug?: string; purpose?: string; link?: string; freeNote?: string; providerSessionId?: string | null; personaId?: string; personaPrompt?: string; runtime?: string; model?: string; reasoningEffort?: string; persistent?: boolean }): Promise<Session>;
  // Null if no live session has this id (e.g. it was never recreated after
  // a restart). The host does not rehydrate sessions from disk on its own.
  get(id: string): Promise<Session | null>;
  list(): Promise<Session[]>;
  delete(id: string): Promise<void>;
  // The global personas catalogue, so an extension can offer the session
  // creator a persona selector. Read-only here — personas are managed from the
  // core Settings view.
  listPersonas(): Promise<Persona[]>;
  // The runtimes installed fleet-wide, first entry = the host default — the
  // session creator's runtime picker (WHAT runs), offered ALWAYS, next to
  // the workspace picker (WHERE). Each runtime declares the options its
  // sessions accept (model, reasoning effort, …) so the creator can render
  // them without hard-coding any runtime's vocabulary.
  listRuntimes(): Promise<RuntimeInfo[]>;
  // Fleet-wide search over the workers' durable provider sessions, streaming
  // per-machine. `on.result` fires as each machine reports hits; `on.done`
  // as each finishes. Resolves with the machines being searched (empty =
  // none connected). Returns an unsubscribe handle — call it when the view
  // unmounts. Host-supplied to ui surfaces.
  searchProviderSessions?(
    term: string,
    on: { result(machine: string, hits: any[]): void; done(machine: string): void },
  ): Promise<{ machines: string[]; stop(): void }>;
  // Fetch one durable provider session's entries from whichever connected
  // machine owns it. Null when no machine has it. Host-supplied to ui
  // surfaces.
  fetchProviderSession?(sessionId: string): Promise<{ machine: string; entries: any[] } | null>;
}

export interface Session {
  // Host-assigned UUID, ephemeral — regenerated each time the session is
  // (re)created in memory. NOT the durable conversation identity; that is
  // `providerSessionId`.
  id: string;
  // The reservation (slot) this session dispatches into. Fixed at create().
  targetId: string;
  // The runtime extension this session's turns execute on, chosen at
  // create(). Null = the host default.
  runtime: string | null;
  // Free-text label the creating extension attached for its own bookkeeping
  // (the host attaches no meaning to it). Empty string when not given.
  purpose: string;
  // The worker-side conversation handle — the durable identity that
  // survives restarts. Null until the first turn completes and the worker
  // reports one back (or until seeded via create()'s providerSessionId).
  providerSessionId: string | null;
  createdAt: string;
  // ISO time of the last turn actually SENT to a worker. null = never
  // dispatched. A queued-but-not-yet-sent dispatch does not update this
  // (it's stamped at send, not at enqueue).
  lastDispatchAt: string | null;
  // `queued` is true when the slot already had a turn in flight, so the
  // dispatch was queued and will go out (emitting `dispatch.sent`) once it
  // frees. The executionId is allocated up front either way.
  dispatch(opts: DispatchOpts): Promise<{ executionId: string; queued?: boolean }>;
  // Subscribe to this session's lifecycle events (dispatch.sent,
  // dispatch.queued, execution.result, execution.event). Returns an
  // unsubscribe fn. Live-only — events fired before you observe are missed.
  observe(handler: (event: SessionEvent) => void): () => void;
  // Page back through the conversation transcript, newest-last. `before`
  // takes a `cursor` from a prior result to fetch the page before it;
  // `limit` caps how many entries come back. The returned `cursor` points
  // at the oldest entry of this page (null when the page is empty), to feed
  // back as `before` for the next older page.
  history(opts?: { limit?: number; before?: string }): Promise<{ entries: SessionEntry[]; cursor: string | null }>;
  // Spawn a sub-session in the same target, parented to this one (so
  // children() can find it). Used to fan work out under a parent.
  createChild(opts: { purpose?: string }): Promise<Session>;
  // The live child sessions created via createChild() under this session.
  children(): Promise<Session[]>;
}

export interface DispatchOpts {
  // Full system prompt for this turn — sent verbatim to the worker. The host
  // does not wrap, template, or merge anything into it: a dispatch is exactly
  // these two prompts.
  systemPrompt: string;
  // The user turn text sent to the agent.
  userPrompt: string;
}

// A session lifecycle event. `type` is one of the emitted names
// ('dispatch.sent' | 'dispatch.queued' | 'execution.result' |
// 'execution.event'); the remaining fields vary by type (executionId,
// sessionId, outcome, …), hence the open index signature.
export interface SessionEvent {
  type: string;
  [key: string]: any;
}

// One turn-transcript line. `tool` carries the tool name on
// tool_call/tool_result kinds. `cursor` is the entry's opaque pagination
// handle (an index into the transcript) — pass it to history({ before }).
export interface SessionEntry {
  kind: 'user' | 'assistant' | 'tool_call' | 'tool_result' | 'error';
  content: string;
  ts: string;
  tool?: string;
  cursor: string;
}

// ── Transcript ──────────────────────────────────────────────────────
//
// A session's conversation as a live, ordered event stream. `subscribe`
// delivers events as the provider produces them — normalized on the worker
// (where the provider's native output lives) and relayed untouched, so the
// UI renders incrementally with no disk round-trip. `history` reads the
// durable record for cold backfill (scrollback, reopening after a restart).
// The format is OURS and provider-agnostic: a worker-side adapter maps each
// provider's native output into these events, so this service, the UI, and
// anything built on it never change when providers do.

// The event stream — the worker's normalized event format (every provider
// adapter already emits this). Streaming `text`/`thinking` grow by `delta`
// while `partial` is true and carry the full `text` on the final boundary;
// a tool call/result pair shares a `callId`; a subagent's own events carry
// its `taskId`/`agentId` so the UI nests them. `turn_start` opens a turn with
// the user prompt; `done` closes it with the stop reason and usage.
export type TranscriptStopReason =
  | 'end_turn' | 'max_tokens' | 'tool_use' | 'stop_sequence' | 'cancelled' | 'error';

// `agentId`/`agentLabel` attribute a row to a sub-agent: `agentId` is the
// correlation id (matches the launching tool_call), `agentLabel` is the
// human-readable sub-agent name (e.g. "code-reviewer") for display + filtering.
// Absent on the top-level agent's own rows.
// `ts` is the row's wall-clock epoch-ms — the JSONL timestamp on cold backfill,
// the relay's arrival stamp on the live plane — surfaced as the transcript's
// left time column. Absent on events that carry no row.
export type TranscriptEvent =
  | { type: 'turn_start'; sessionId: string; userPrompt: string; ts?: number }
  | { type: 'text'; sessionId: string; id: string; delta: string; partial: boolean; text?: string; agentId?: string; agentLabel?: string; ts?: number }
  | { type: 'thinking'; sessionId: string; id: string; delta: string; partial: boolean; text?: string; agentId?: string; agentLabel?: string; ts?: number }
  | { type: 'tool_call'; sessionId: string; callId: string; name: string; input: any; partial: boolean; agentId?: string; agentLabel?: string; ts?: number }
  | { type: 'tool_result'; sessionId: string; callId: string; output: any; isError: boolean; durationMs: number; agentId?: string; agentLabel?: string; ts?: number }
  | { type: 'subagent_start'; sessionId: string; taskId: string; name: string; prompt: string; parentCallId: string }
  | { type: 'subagent_end'; sessionId: string; taskId: string; result: string; isError: boolean; usage: TokenUsage }
  | { type: 'usage'; sessionId: string; usage: TokenUsage }
  | { type: 'error'; sessionId: string; code: string; message: string; recoverable: boolean; ts?: number }
  | { type: 'done'; sessionId: string; stopReason: TranscriptStopReason; usage: TokenUsage };

export interface Transcript {
  // LIVE: stream a session's events as they're produced. Returns an
  // unsubscribe fn. Future-only — pair with history() for what came before.
  subscribe(sessionId: string, onEvent: (e: TranscriptEvent) => void): () => void;
  // COLD: paged durable backfill, newest-last. `before` takes a prior cursor
  // to page further back; the returned `cursor` is null when there's no
  // older page. Works across restarts (keyed by the durable session).
  history(sessionId: string, opts?: { before?: string; limit?: number }): Promise<{ events: TranscriptEvent[]; cursor: string | null }>;
}

// ── MCP ─────────────────────────────────────────────────────────────
//
// Lets an extension expose tools to the agent over MCP. Registered tools
// are namespaced by extension id, so two extensions can register a tool
// with the same `name` without clashing.

// Passed to a tool handler at call time. `sessionId` identifies the agent
// run that invoked the tool, so a handler can scope its work / look up
// per-session state.
export interface ToolContext {
  sessionId: string;
}

// What a tool handler returns to the agent. `content` is the MCP
// text-block result. `isError: true` marks the call as failed so the
// agent sees it as an error rather than a normal result.
export interface ToolResult {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
}

export interface ToolSpec {
  // Tool name as the agent sees it (within this extension's namespace).
  name: string;
  // Optional human display title; falls back to `name` in UIs.
  title?: string;
  description: string;
  // JSON Schema for the tool's arguments. The host converts it to the Zod
  // shape the MCP SDK wants; omit it for a no-argument tool.
  inputSchema?: Record<string, any>;
  // The implementation. May be sync or async; receives the parsed `args`
  // and the call `ctx`.
  handler: (args: any, ctx: ToolContext) => Promise<ToolResult> | ToolResult;
}

export interface Mcp {
  registerTool(spec: ToolSpec): void;
}

// ── Scheduler ───────────────────────────────────────────────────────
//
// Fire-and-forget recurring timers owned by an extension. Entries are
// in-memory (re-registered on each load) and auto-disposed when the
// extension deregisters. A throwing/rejecting handler is swallowed so one
// bad run never tears down the timer.

export interface ScheduleSpec {
  // 'interval' uses `interval`; 'cron' uses `cron`. The unused field for
  // the chosen kind is ignored (register() throws if the needed one is
  // missing/invalid).
  kind: 'interval' | 'cron';
  // Period in MILLISECONDS for kind 'interval' (must be > 0).
  interval?: number;
  // Standard 5-field cron expression for kind 'cron' (e.g. "0 9 * * *").
  cron?: string;
}

export interface Scheduler {
  // `id` is scoped to the extension; re-registering the same id replaces
  // the existing timer rather than stacking a second one.
  //
  // `reservationId` declares that this schedule RUNS WORK ON a reservation
  // (e.g. a nightly dispatch against a slot pinned to a cheaper model). The
  // host records the schedule on that reservation, so the Workspaces view
  // shows the slot is scheduled and warns before freeing it. Pure timers
  // that dispatch nothing (UI refresh, reconcile sweeps) omit it — a timer
  // is not capacity and must not hold a slot.
  register(opts: { id: string; schedule: ScheduleSpec; handler: () => void | Promise<void>; reservationId?: string }): void;
  unregister(id: string): void;
}

// ── Hooks ───────────────────────────────────────────────────────────
//
// Hooks are a generic extension point. The host fires a named hook at
// well-defined moments in core flows; any extension can register a
// handler to run arbitrary work at that moment. The host attaches no
// meaning to what a handler does — a hook is purely a place to plug
// in. The context object a handler receives describes the *event*
// (what is happening, where), never a capability for a particular
// kind of work. The actual work — running a command, reading the
// store — comes from the `services` the handler calls, not the hook.
//
// Versioning: a hook name is a stable contract. Once shipped, it must
// keep firing with the documented context shape forever. Any
// behavioural or shape change ships as a new version (`...v2`); the
// old version stays registered but is flagged deprecated (see
// hooks.ts DEPRECATED), so existing extensions keep working while
// authors migrate.
//
// Execution & intent: each registration declares its own intent —
// `blocking` and `timeoutMs` — because only the extension knows whether
// its work must finish before the flow proceeds.
//
//   blocking: true  — the core flow waits for this handler before
//                     continuing (bounded by timeoutMs). Use when the
//                     handler's effect must land first. A VCS extension's
//                     post-dispatch commit/push MUST block: if it ran
//                     async, the next dispatch could check out a new
//                     commit on top of an un-committed working tree and
//                     corrupt the session's history.
//   blocking: false — fire-and-forget. The flow does not wait. Use for
//                     side work that has no ordering constraint with the
//                     flow (telemetry, notifications).
//
//   timeoutMs       — the maximum time the handler is expected to take.
//                     If a blocking handler exceeds it, it is considered
//                     STUCK: the host logs and proceeds anyway (it will
//                     not wedge the flow forever) and the straggler keeps
//                     running detached. Pick a value comfortably above
//                     the handler's real worst case (a slow push, a large
//                     checkout) — exceeding it is treated as a fault.
//
// Blocking handlers run sequentially in registration order; the host
// `await`s each. Non-blocking handlers are kicked off when reached and
// not awaited. A throwing handler is logged and skipped — a fault in one
// handler never breaks the flow or the other handlers. Hooks are not
// gatekeepers: there is no way to veto/abort the flow from a handler. If
// a flow ever needs veto semantics, that is a different contract and
// should be a distinctly named hook (e.g. "session.gate_dispatch.v1").

export const HOOKS = {
  /**
   * Fires immediately before a session dispatch is sent to a worker.
   * Context: SessionDispatchHookContext. Handlers can do any
   * pre-flight work — e.g. position a working directory, verify the
   * target machine has capacity, record an audit entry. To act on the
   * worker, use `services.machines.exec`.
   */
  SESSION_PRE_DISPATCH_V1: 'session.pre_dispatch.v1',

  /**
   * Fires after a session dispatch completes (success, error, or
   * stranded). Context: SessionPostDispatchHookContext. Handlers can
   * do any teardown/follow-up work keyed off the outcome.
   */
  SESSION_POST_DISPATCH_V1: 'session.post_dispatch.v1',

  // ── Lifecycle hooks (not per-turn) ──────────────────────────────
  // The dispatch hooks above bracket a single TURN. These bracket the
  // longer-lived resources a turn runs on — the slot reservation and the
  // session — firing once at each end of their life, not per dispatch.

  /**
   * Fires after a reservation is successfully created (a slot is held).
   * Context: ReservationCreatedHookContext.
   */
  RESERVATION_CREATED_V1: 'reservation.created.v1',

  /**
   * Fires after a reservation is released (the slot is freed).
   * Context: ReservationReleasedHookContext.
   */
  RESERVATION_RELEASED_V1: 'reservation.released.v1',

  /**
   * Fires after a session is created. Context: SessionCreatedHookContext.
   */
  SESSION_CREATED_V1: 'session.created.v1',

  /**
   * Fires after a session is deleted. Context: SessionDeletedHookContext.
   */
  SESSION_DELETED_V1: 'session.deleted.v1',
} as const;

export type HookName = typeof HOOKS[keyof typeof HOOKS] | string;

// Context for the session dispatch hooks. Describes the dispatch —
// which session, which slot (reservation), which machine, which
// directory. Nothing here is tied to any particular kind of extension; a
// handler uses these facts plus the `services` it calls to do whatever
// it needs.
export interface SessionDispatchHookContext {
  sessionId: string;
  reservationId: string;
  machine: string;
  directory: string;
}

export interface SessionPostDispatchHookContext extends SessionDispatchHookContext {
  outcome: 'success' | 'error' | 'stranded';
  error?: string;
}

// Context for the lifecycle hooks. Each describes the resource at the moment
// it came or went — enough to key follow-up work off without a lookup.
export interface ReservationCreatedHookContext {
  reservationId: string;
  workspaceId: string;
  ownerId: string;
  machine: string;
  directory: string;
}

export interface ReservationReleasedHookContext {
  reservationId: string;
  workspaceId: string;
  ownerId: string;
}

export interface SessionCreatedHookContext {
  sessionId: string;
  workspaceId: string;
  ownerId?: string;
  runtime: string;
}

export interface SessionDeletedHookContext {
  sessionId: string;
}

export interface HookRegistration {
  // Versioned hook name; prefer the HOOKS constants over raw literals.
  hook: HookName;

  // Does the core flow wait for this handler before continuing?
  // Declare it explicitly — only the extension knows whether its work
  // is load-bearing for the flow. See the intent notes above.
  blocking: boolean;

  // Maximum time the handler is expected to take, in ms. A blocking
  // handler that exceeds this is treated as stuck: the host stops
  // waiting and proceeds (the straggler keeps running detached). Set
  // it above the handler's real worst case.
  timeoutMs: number;

  // The handler's `ctx` shape is defined per-hook (see HOOKS comments).
  handler: (ctx: any) => void | Promise<void>;
}

export interface Hooks {
  /**
   * Register a hook handler. Returns an unregister fn; auto-cleaned on
   * extension deregister.
   */
  register(reg: HookRegistration): () => void;
}

// ── Worker channel (extension server ↔ its worker component) ───────
//
// An extension that ships a worker/ entry gets a private, machine-scoped
// message link between its server/ code (host process) and that component
// (daemon process). One generic envelope rides the daemon's WebSocket each
// way; the platform guarantees ordered delivery of opaque JSON payloads
// scoped to (extension, machine) — nothing more. Request/response
// correlation, ids, chunking, what the payloads mean: that is the
// extension's own protocol between its two halves.

// Host side — the server capability's handle to one machine's component.
export interface WorkerChannel {
  // Deliver one payload to this extension's worker component on the machine.
  // Throws when the machine is not connected; nothing is queued.
  send(payload: any): void;
  // Payloads the component sent from this machine. Returns an unsubscribe
  // fn; handlers are also auto-removed when the extension deregisters.
  onMessage(handler: (payload: any) => void): () => void;
  // Whether the machine's daemon link is open right now.
  connected(): boolean;
}

// Daemon side — the component's end of the same link (the one machine it
// runs on, so no machine parameter here).
export interface WorkerComponentChannel {
  // Deliver one payload to the extension's server code on the host. Dropped
  // (with a log) while the daemon link is down.
  send(payload: any): void;
  onMessage(handler: (payload: any) => void): () => void;
}

// ── Capabilities ────────────────────────────────────────────────────
//
// An extension is a set of capabilities, one directory each (all optional):
//
//   ui/      register views, sidebar sections, commands, modals, welcome tiles
//   server/  the extension's host-side backend: bus responders for its UI,
//            plus the worker channel to its own worker components
//   hooks/   register handlers the host runs at moments in a flow
//   mcp/     register tools an AI model can invoke
//   runtime/ back a provider — run agent sessions + stream the transcript
//            (Claude Code, OpenCode); runs ON THE WORKER, not the host
//   worker/  the extension's daemon-side component — logic that runs next to
//            the files on every connected machine and streams to its server/
//            code over the worker channel
//
// A capability is a place you contribute into — the host discovers your
// contribution and invokes it at the right moment. Each capability's
// register() receives its own context: the surfaces you register into, plus
// `services` — the backing services your code calls to do its work (`store`,
// `sessions`, `config`, `machines`, `scheduler`, defined above). You call a
// service directly; how it reaches its data is not your concern.
//
// Capabilities are separate instances and do not share memory: a value `ui`
// keeps in a module variable is invisible to `hooks`. They coordinate through
// a service (typically the store).
//
// register() receives a Provider, not the capability directly — call
// version(n) for the interface your code targets. The interface IS the
// version: UiV1 is the v1 shape; a breaking change ships a new UiV2 interface
// (plus a version(2) overload and a v2 builder) while v1 keeps working. Ask
// for a retired version and the provider throws an informative migration error.

// ── ui ──────────────────────────────────────────────────────────────
export interface UiV1 {
  id: string;
  // The extension's Bus, same shape the backend capabilities get: its private
  // channel (UI ↔ its own backend), the core channel (host responders +
  // events), and other extensions' public endpoints.
  bus: Bus;
  views: { register(def: ViewDefinition): void };
  sidebar: {
    register(def: SidebarDefinition): void;
    // Attach/update a number badge on a registered item. null or 0 clears it.
    setBadge(id: string, count: number | null): void;
  };
  commands: { register(cmd: CommandDefinition): void; unregister(id: string): void };
  welcome: { contribute(tile: WelcomeTile): void; remove(id: string): void };
  modals: {
    // Open a one-shot prompt modal and await the user. Resolves with the field
    // values keyed by each field's `key`, or null if cancelled.
    prompt(opts: PromptOptions): Promise<Record<string, string> | null>;
    // Open a confirm modal and await the choice. The HOST renders it, centered
    // over the whole app — a webview-rendered overlay can only cover its own
    // iframe (a sidebar section's overlay is trapped inside the sidebar), so
    // destructive actions must confirm through this.
    confirm(opts: ConfirmOptions): Promise<boolean>;
  };
  // Custom URI scheme plumbing (e.g. "frontier://…" deep links).
  uri: {
    handle(scheme: string, handler: (uri: string) => void): void;
    resolve(uri: string): Promise<unknown>;
    open(uri: string): boolean;
    build(scheme: string, path: string): string;
    parse(uri: string): { scheme: string; path: string } | null;
  };
  // Device-local, per-extension key/value preferences for UI state (column
  // widths, sort orders, expanded sets). Synchronous, JSON-serialized, and
  // namespaced per extension — extensions never touch global localStorage
  // keys. Deliberately device-local: never synced between devices and never
  // in the Store (durable, shared data belongs there).
  prefs: {
    get<T = any>(key: string, fallback?: T): T | undefined;
    set(key: string, value: any): void;
    delete(key: string): void;
    // Observe a key. Fires on every change, including writes from the
    // extension's other documents (controller / other surfaces).
    watch(key: string, cb: (value: any) => void): () => void;
  };
  // Route the app to `path` (opens/focuses the tab it resolves to). `preview`
  // opens a single-click preview tab (promoted to a permanent tab on
  // double-click) instead of a pinned one.
  navigate(path: string, opts?: { preview?: boolean }): void;
  // Close the tab for `path` if open.
  closeTab(path: string): void;

  // Backing services this capability calls.
  services: {
    store: Store;
    sessions: Sessions;
    workspaces: Workspaces;
    config: Config;
    machines: MachineRegistry;
    fs: Fs;
    http: Http;
    voice: Voice;
    transcript: Transcript;
  };

  // Register a teardown fn run when the UI is unloaded.
  deregister(fn: () => void): void;
}

// ── server ──────────────────────────────────────────────────────────
//
// The extension's host-side backend. register() runs in the host process at
// load. It answers its own UI over bus.extension (respond/publish there) and
// is the ONLY capability that reaches the extension's worker components —
// the daemon-side worker/ halves — via workers.channel(machine).
export interface ServerV1 {
  id: string;
  // The extension's bus: its private channel (your UI's requests land here),
  // its public versioned endpoints, and read-only views of other extensions.
  bus: Bus;
  workers: {
    // The machine-scoped link to THIS extension's worker component on a
    // connected machine. A channel is a cheap handle over live connection
    // state — send() throws while the machine is disconnected, and
    // onMessage handlers are auto-cleaned on deregister.
    channel(machine: string): WorkerChannel;
  };

  // Backing services the server code calls.
  services: {
    store: Store;
    sessions: Sessions;
    workspaces: Workspaces;
    config: Config;
    machines: MachineRegistry;
    scheduler: Scheduler;
    http: Http;
  };

  deregister(fn: () => void | Promise<void>): void;
}

// ── hooks ───────────────────────────────────────────────────────────
export interface HooksV1 {
  id: string;
  // Register a handler the host runs at a defined moment (see HOOKS).
  // Returns an unregister fn; also auto-cleaned on unload.
  register(reg: HookRegistration): () => void;

  // Backing services a handler calls.
  services: {
    store: Store;
    sessions: Sessions;
    workspaces: Workspaces;
    config: Config;
    machines: MachineRegistry;
    scheduler: Scheduler;
    http: Http;
  };

  deregister(fn: () => void | Promise<void>): void;
}

// ── mcp ─────────────────────────────────────────────────────────────
export interface McpV1 {
  id: string;
  // Register a tool an AI model can invoke during a session.
  registerTool(spec: ToolSpec): void;

  // Backing services a tool handler calls.
  services: {
    store: Store;
    sessions: Sessions;
    workspaces: Workspaces;
    config: Config;
    machines: MachineRegistry;
    scheduler: Scheduler;
    http: Http;
  };

  deregister(fn: () => void | Promise<void>): void;
}

// ── runtime ─────────────────────────────────────────────────────────
//
// A runtime backs a provider: it runs one agent turn on the worker machine
// and streams the transcript as the agent works. Claude Code and OpenCode are
// runtimes. Unlike ui/hooks/mcp, a runtime runs ON THE WORKER (bundled and
// shipped there), so its register() is invoked by the worker daemon.

export interface RuntimeRunInput {
  // Durable provider-session id — the resume handle when `resume` is true.
  sessionId: string;
  systemPrompt: string;
  userPrompt: string;
  // Continue the existing `sessionId` conversation, or start fresh.
  resume: boolean;
  // The slot's directory on this machine, where the agent runs.
  workspaceDir: string;
  // Per-session provider model + reasoning depth, threaded from the dispatch.
  // Opaque strings, runtime-interpreted (each runtime maps them onto its own
  // agent/SDK); when present they OVERRIDE the runtime's default, absent leaves
  // the runtime's default in place.
  model?: string;
  reasoningEffort?: string;
  // Latency opt-in threaded from the dispatch: the runtime may keep its
  // provider process alive between this session's turns. A runtime that
  // cannot is free to ignore it — the contract is per-turn either way.
  persistent?: boolean;
  // The chosen persona's preamble text, threaded from the dispatch. When set,
  // the runtime prepends it to `systemPrompt` before handing it to its agent.
  personaPrompt?: string;
  // The MCP endpoint exposing this extension's tools to the agent, if any.
  // `auth` carries per-turn headers (e.g. the execution-id the tool gateway
  // scopes calls by).
  mcpEndpoint?: { url: string; auth?: Record<string, string> };
  // Additional user-configured MCP servers to expose alongside mcpEndpoint.
  // Opaque + runtime-interpreted (each runtime maps it to its own agent's MCP
  // config); the daemon passes it through verbatim from the dispatch.
  userMcpServers?: Record<string, unknown>;
  // Extra environment variables to set on the agent process for this turn
  // (e.g. the dir the persist subagent writes its result to).
  env?: Record<string, string>;
  // Per-turn agent/subagent definitions to install before the run (name →
  // definition body). Runtime-interpreted; absent for turns that install none.
  instructions?: Record<string, string>;
  // Dispatch correlation, for the runtime's own telemetry/logging only.
  executionId: string;
  role: string;
  // Stream transcript events as the turn unfolds — the live plane. Call it
  // for every text/thinking delta, tool call/result, subagent event, etc.
  emit(event: TranscriptEvent): void;
  // Aborts the turn when the dispatch is cancelled.
  signal: AbortSignal;
}

export interface RuntimeRunResult {
  stopReason: TranscriptStopReason;
  usage: TokenUsage;
  // The (possibly new) durable session handle to persist for the next resume.
  providerSessionId?: string;
  // The turn's final assistant text, recorded as the durable assistant entry.
  responseText?: string;
  error?: string;
}

export interface RuntimeSyncInput {
  workspaceDir: string;
  // 'in' = make the slot's files present before a run; 'out' = publish
  // results after.
  direction: 'in' | 'out';
}

// The cold/history plane for a runtime's durable sessions on this worker. The
// daemon delegates the session.* worker queries to these; the runtime owns
// reading + parsing its own on-disk session format. Params/rows are the
// daemon's legacy worker-query wire shapes (kept opaque here): the host maps
// the rows to TranscriptEvents — see entryToTranscriptEvent in backend/index.
export interface RuntimeHistory {
  // params: { sessionId, cwd?, limit?, before?, all? } → entry rows (a newest-
  // last window, or the whole session when all). The daemon chunks them back.
  readSession(params: any): Promise<any[]>;
  // params: { sessionId, lineIdx, blockIdx, agentId?, cwd? } → one entry's full
  // body, or null when the line/session is gone.
  readEntry(params: any): Promise<any | null>;
  // params: { term, … } → matching session summaries across this worker.
  searchSessions(params: any): Promise<any[]>;
  // Diagnostic dump for a "why is this session empty?" probe. Optional.
  debugSession?(params: any): Promise<any>;
}

export interface RuntimeImpl {
  // A runtime is identified by its extension id — the dispatch names that id and
  // the daemon routes the turn to this impl. There is no separate routing token
  // to keep in sync (and nothing to forget to update when an extension is
  // forked): the extension IS the runtime.
  //
  // Run one dispatched turn, emitting transcript events live; resolves when
  // the turn completes (or is aborted via input.signal).
  run(input: RuntimeRunInput): Promise<RuntimeRunResult>;
  // Read this runtime's durable sessions on the worker (the cold plane). Omit
  // for a runtime whose sessions aren't browsable as transcripts.
  history?: RuntimeHistory;
  // Bring the work area's files onto this machine before a run and publish
  // them after. Omit when the runtime works in place on the existing directory.
  syncDirectory?(input: RuntimeSyncInput): Promise<void>;
}

export interface RuntimeV1 {
  id: string;
  // Register this extension's runtime implementation.
  register(impl: RuntimeImpl): void;
  // Backing services a runtime calls.
  services: {
    // The runtime's own configuration.
    config: Config;
    // Dynamically import a module installed on the worker, resolved from the
    // daemon's location (where the host's node_modules live) rather than the
    // runtime bundle's temp path. How a runtime reaches its provider SDK (e.g.
    // the Claude Agent SDK) without statically bundling it.
    importWorker(specifier: string): Promise<any>;
  };
  deregister(fn: () => void | Promise<void>): void;
}

// ── worker ──────────────────────────────────────────────────────────
//
// A worker component is the extension's daemon-side half: like runtime/, the
// host bundles worker/index.ts to node CJS and every connected worker daemon
// fetches + require()s + registers it on connect (manifest hasWorker /
// workerHash; a bundle that fails to load is logged and skipped). Unlike a
// runtime it backs no provider — it exists so extension logic can run next
// to the machine's files and stream to its own server/ code over `channel`.
export interface WorkerV1 {
  id: string;
  // The link to this extension's server code on the host (see
  // WorkerComponentChannel above).
  channel: WorkerComponentChannel;
  services: {
    // Dynamically import a module installed on the worker, resolved from the
    // daemon's location — same contract as the runtime capability's.
    importWorker(specifier: string): Promise<any>;
    // Synchronous require with the same daemon-located resolution. For CJS /
    // native modules — including an absolute path to a prebuilt package the
    // component extracted itself (require() resolves a directory's
    // package.json main; import() does not).
    requireWorker(specifier: string): any;
    // The http origin of the host this daemon is connected to (the same
    // origin the component's own bundle was fetched from). For host-served
    // static assets, e.g. native-module prebuilts under /daemon-deps/.
    hostUrl: string;
  };
  deregister(fn: () => void | Promise<void>): void;
}

// A provider vends a capability at a requested version — version(1) returns
// the V1 interface, typed. The interface itself is the version (UiV1), so a
// breaking change is a new interface (UiV2) reached via a new overload
// (version(2): UiV2); the host keeps building every version it still supports
// and throws an informative migration error for a retired one.
export interface UiProvider {
  version(v: 1): UiV1;
}
export interface ServerProvider {
  version(v: 1): ServerV1;
}
export interface HooksProvider {
  version(v: 1): HooksV1;
}
export interface McpProvider {
  version(v: 1): McpV1;
}
export interface RuntimeProvider {
  version(v: 1): RuntimeV1;
}
export interface WorkerProvider {
  version(v: 1): WorkerV1;
}

// ── workspace ───────────────────────────────────────────────────────
//
// A workspace provider owns the working directory + VCS for a kind of workspace
// (git, mercurial, …). It runs ON THE HOST, reaching the worker via
// `services.machines.exec`, and brackets a RESERVATION's life with begin/end
// (not each turn). git/mercurial each ship their own provider via this
// capability, so the core carries no VCS knowledge — a new VCS is a new
// extension, never a core edit. The contract types live in the runtime-free
// `./workspaceTypes` (so this contract compiles in the frontend's node-type-free
// build) and are re-exported here for extensions.
export type { Workspace, WorkspaceProvider, SlotDescriptor, ReservationProviderContext, Reservation } from './workspaceTypes';

export interface WorkspaceProviderV1 {
  id: string;
  // Register this extension's workspace provider into the host registry.
  register(provider: WorkspaceProvider): void;
  // Backing services a provider calls (git/hg run via machines.exec).
  services: {
    machines: MachineRegistry;
    config: Config;
    store: Store;
  };
  deregister(fn: () => void | Promise<void>): void;
}
export interface WorkspaceProviderProvider {
  version(v: 1): WorkspaceProviderV1;
}

// ── UI contribution types ───────────────────────────────────────────
//
// The payloads an extension passes to its FrontierUI capabilities
// (ui.views.register, ui.sidebar.register, …). They are
// framework-agnostic — the host hands an extension a plain HTMLElement and
// the extension renders into it however it likes (React, vanilla,
// anything), so no UI-framework types cross the boundary. The one
// renderable node that does — a tab's status glyph — stays `any` for
// exactly that reason (see TabLabel.statusIcon). The host UI's store
// records (frontend/src/extensions/extensionStore.ts) are these same
// shapes plus an `extensionId` the host fills in.

// A tab's label: a plain string, or structured text the tab bar renders.
export interface TabLabel {
  // The main tab caption.
  primary: string;
  // Dimmed text after the primary (e.g. a path fragment or context). Omit
  // for none.
  secondary?: string;
  // A short status word/badge the tab bar may render alongside the caption.
  status?: string;
  // A self-contained SVG markup string the host renders as an isolated
  // image (data: URI). The extension owns the glyph — shape, colour and
  // any animation baked in — and the host renders it without knowing what
  // it means, so any extension can show any indicator. It's isolated, so
  // no external CSS/classes reach it: bake everything into the SVG.
  statusIcon?: string;
  // Anchor for a live elapsed-time readout on the tab (the bar ticks
  // "since this instant" every second). Set it to when the current
  // activity began; null/omitted shows no timer.
  sinceIso?: string | null;
}

// A view — a tab type the extension owns end to end. There is no browser URL;
// tab ids are the canonical handle. Routing is DECLARATIVE + serializable: the
// view declares its `tabType` and the path prefixes it owns, and the host runs
// the resolution (path → tabId, tabId → owner) itself — see the routing rules
// below. This matters because the host runs in a different webview from the view
// body, so it can't call a routing CLOSURE across the boundary; it can only read
// declared data.
//
// Routing rules the HOST implements from `tabType` + `routes`:
//   • A pathname matches this view when some route satisfies
//       exact ? pathname === prefix : pathname.startsWith(prefix)
//   • Its tab id is
//       exact ? tabType : tabType + ':' + pathname.slice(prefix.length).replace(/^\//, '')
//   • A stored tab id belongs to this view when
//       tabId === tabType || tabId.startsWith(tabType + ':')
//
// So a view's tab-id scheme MUST be `tabType` (exact route) or `tabType:<suffix>`
// (prefix route) for the host's resolution to round-trip. Labels are PUSHED via
// ctx.setLabel (host-cached) rather than pulled — there is no tabLabel function.
export interface ViewDefinition {
  id: string;
  // The tab "type" tag — the stable prefix of every tab id this view owns.
  tabType: string;
  // Declarative routes: the logical navigate() path prefixes this view answers
  // to. `exact` matches the prefix verbatim (a singleton tab); otherwise any
  // path that starts with the prefix matches, and the remainder becomes the tab
  // id suffix.
  routes: Array<{ prefix: string; exact?: boolean }>;
  // Render the tab's content into `container` (a fresh host-owned element, the
  // body of this view's own render webview). `ctx` is scoped to THIS instance:
  // push its label, subscribe to save/activate/deactivate through it.
  mount(tabId: string, container: HTMLElement, ctx: ViewContext): void;
  // Tear down what mount() built into `container`. Optional — omit if
  // there's nothing to clean up.
  unmount?(container: HTMLElement): void;
}

// Per-view-instance context handed to ViewDefinition.mount(). It backs the
// signals that used to live on the (now-removed) ui.onSave/onTabsChanged/
// refreshLabels, but scoped to ONE open tab and routed across the webview
// boundary to the host:
//   setLabel — push this tab's label; the host caches it and re-renders the tab
//              bar synchronously. Call on mount and again whenever the data
//              behind the label changes (a rename, a lifecycle flip).
//   onSave   — fires when the user hits Cmd/Ctrl+S WHILE this tab is the active
//              one. Returns an unsubscribe fn.
//   onActivate / onDeactivate — fire when the host shows / hides this tab's
//              webview (a tab switch). Use them to gate per-tab polling, pause
//              work, etc. Both return an unsubscribe fn.
export interface ViewContext {
  setLabel(label: string | TabLabel): void;
  onSave(handler: () => void): () => void;
  onActivate(handler: () => void): () => void;
  onDeactivate(handler: () => void): () => void;
}

// A sidebar section.
export interface SidebarDefinition {
  id: string;
  title: string;
  mount(container: HTMLElement): void;
  unmount?(): void;
  // Toolbar buttons rendered in the section header; each runs a registered
  // command by id when clicked. `icon` is the glyph, `tooltip` the hover text.
  actions?: Array<{ commandId: string; icon: string; tooltip: string }>;
  // Where the item lands the FIRST time it's seen (no stored assignment
  // yet). 'left' | 'right' | 'bottom'; defaults to 'left' when omitted.
  // Once placed, the user's panel choice (drag-to-move) is authoritative
  // and persisted — this only seeds the initial position.
  defaultPlacement?: 'left' | 'right' | 'bottom';
  // A command to run when the item's number badge is clicked. The badge
  // value is set imperatively via frontend.sidebar.setBadge(id, count).
  // If omitted, the badge is non-interactive (clicks fall through to the
  // item). Mirrors a VSCode activity-bar badge.
  badgeCommandId?: string;
}

// A command — a palette entry / keybinding.
export interface CommandDefinition {
  id: string;
  // Text shown in the command palette.
  label: string;
  // Palette grouping heading. Optional — uncategorised when omitted.
  category?: string;
  // Suggested default keybinding (e.g. "ctrl+k"). The user can rebind; this
  // only seeds the initial binding. Omit for none.
  defaultKey?: string;
  run(): void;
}

// A tile on the welcome screen.
export interface WelcomeTile {
  id: string;
  title: string;
  description: string;
  // Optional call-to-action button on the tile. Omit for an
  // information-only tile.
  action?: { label: string; run(): void };
}

// One field in a prompt modal (frontend.modals.prompt). `key` is the name
// this field's value appears under in the resolved result object.
export interface PromptField {
  key: string;
  label: string;
  // 'string' = text input; 'select' = dropdown (requires `options`).
  type: 'string' | 'select';
  placeholder?: string;
  // Choices for a 'select' field. Ignored for 'string'.
  options?: Array<{ value: string; label: string }>;
  // When true, the modal blocks submit until this field has a value.
  required?: boolean;
  default?: string;
}

export interface PromptOptions {
  // Modal heading.
  title: string;
  // Optional body text under the heading — context or a caution the user
  // should read before filling the fields.
  description?: string;
  fields: PromptField[];
  // Caption on the confirm button. Defaults to a generic label when omitted.
  submitLabel?: string;
}

// Options for frontend.modals.confirm — a host-rendered yes/no gate, used
// before destructive actions. Crosses the webview postMessage boundary, so
// everything here must be plain data (message is a string, not a node).
export interface ConfirmOptions {
  // Modal heading.
  title: string;
  // Body text — say what is destroyed and that it can't be undone.
  message: string;
  // Caption on the confirm button. Defaults to 'Delete'.
  confirmLabel?: string;
  // Style the confirm button as destructive. Defaults to true.
  danger?: boolean;
}



// ── Extension metadata ──────────────────────────────────────────────

// The extension's manifest fields the host actually consumes — its display
// name, accent colour (used to tint its UI chrome / badges), and an optional
// human description surfaced in the core Extensions UI.
export interface ExtensionManifest {
  displayName: string;
  defaultColor: string;
  description?: string;
  // Declared outbound network access. `allowedHosts` is the baseline set of
  // hostnames this extension's code may reach via `services.http` — exact host
  // or registrable suffix ("archive.org" allows "web.archive.org"), or "*" for
  // any external host (still SSRF-guarded against internal addresses). Shown in
  // the install trust dialog; the user can narrow or widen it per install.
  network?: { allowedHosts: string[] };
}

// A loaded extension instance, tracked by the host registry.
export interface LoadedExtension {
  id: string;
  // Absolute path to the extension's directory on disk.
  dir: string;
  manifest: ExtensionManifest;
  // Unload hook — runs the extension's deregister fns and frees its host
  // registrations. Called on reload/shutdown.
  dispose: () => Promise<void>;
}

// ── Host internals (not exposed to extensions) ──────────────────────

// The fully-resolved unit of work the host sends to a worker. Assembled by
// the host from a Session.dispatch call once a concrete work area has been
// picked — the extension never constructs this directly.
export interface DispatchRequest {
  // Unique id for THIS turn/attempt — correlates the eventual
  // ExecutionResult and lifecycle events back to the dispatch.
  executionId: string;
  // The host session this turn belongs to.
  sessionId: string;
  // Owning extension — namespaces worker metadata and routes the result back.
  extensionId: string;
  // The reservation this turn runs on (the dispatch id — sessions carry it
  // as targetId). The engine resolves it to the slot's machine + directory.
  targetId: string;
  systemPrompt: string;
  userPrompt: string;
  // Resume handle — the worker continues this prior provider conversation
  // instead of starting fresh. Null/absent = a new conversation.
  providerSessionId?: string | null;
  // The session's chosen runtime extension (which agent runs the turn) plus
  // provider model + reasoning depth, carried verbatim to the worker. Absent
  // runtime = the host default; absent model/effort = the runtime's default.
  runtime?: string;
  model?: string;
  reasoningEffort?: string;
  // The session persona's preamble text, resolved per turn from the session's
  // personaId. The runtime prepends it to the system prompt. Absent = no persona.
  personaPrompt?: string;
  // Latency opt-in for live conversation: the runtime MAY hold its provider
  // process open between this session's turns (streaming input) so a turn
  // skips the spawn/resume/MCP-connect cost. Only meaningful for sessions
  // whose working directory is stable across turns.
  persistent?: boolean;
}

// Per-turn token usage reported by a runtime adapter. Counts only — the
// provider SDKs do not expose a context-window maximum. camelCase to match
// the rest of the host-facing surface; the daemon normalises the adapters'
// snake_case shape before it reaches here.
export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  costUsd: number;
}

// The outcome of one dispatched turn, reported back to the host (which
// fans it out as an 'execution.result' SessionEvent).
export interface ExecutionResult {
  // Matches the DispatchRequest.executionId this is the result for.
  executionId: string;
  sessionId: string;
  // 'success' / 'error' come from the worker. 'stranded' is synthesised by
  // the host when it can prove the worker never returned (finished or
  // crashed and the real result message was lost) — so a hung dispatch
  // doesn't pin the session as forever-running.
  outcome: 'success' | 'error' | 'stranded';
  // Failure detail, present on the 'error'/'stranded' paths.
  error?: string;
  // The (possibly new/updated) worker conversation handle for continuity —
  // the host stores it on the session so the next turn resumes correctly.
  providerSessionId?: string;
  // Transcript lines produced by this turn, appended to the session history.
  conversationEntries?: SessionEntry[];
  // Token usage for the completed turn, when the adapter reported it.
  usage?: TokenUsage;
}
