// The dir-sync daemon-side engine. Worker-channel protocol (every request
// carries a unique reqId; every response echoes it as `<op>.res`):
//
//   scan    { root, exclusions, maxFileBytes } → scan.res chunks of
//           { files:[{rel,size,mtimeMs,mode}], done } + counts on the final one
//   hash    { root, rels } → hash.res { hashes:{rel:sha256}, errors:{rel:msg} }
//   read    { root, rel, offset, length } → read.res { dataB64, bytes }
//   write.open/.chunk/.close { writeId, … } → write.*.res — open allocates a
//           temp file, chunks land at explicit offsets, close stamps
//           mtime+mode and renames into place; write.abort discards it
//   delete  { root, rels } → delete.res { deleted, errors } (prunes empty dirs)
//   touch   { root, items:[{rel,mtimeMs}] } → touch.res
//   mirror  { sourceRoot, targetRoot, exclusions, maxFileBytes } → mirror.res
//           — the same scan/diff/copy/delete pipeline run entirely locally
//           (both endpoints on this machine; no host relay)
//
// Symlinks are skipped (lstat semantics — counted, never followed), excluded
// names match any path segment, and every rel is validated to stay under root.
// Exclusions and the per-file size cap make a file invisible to BOTH sides of
// the mirror: never copied from the source, never deleted on the target.

import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as path from 'path';
import { createHash } from 'crypto';
import type { WorkerProvider } from '../../types';

const SCAN_BATCH = 1000;
const MAX_FILES = 200_000;
const WRITE_IDLE_SWEEP_MS = 60_000;
const WRITE_IDLE_MAX_MS = 180_000;

interface FileEntry { rel: string; size: number; mtimeMs: number; mode: number }
interface ScanResult {
  files: FileEntry[];
  symlinksSkipped: number;
  largeSkipped: Array<{ rel: string; size: number }>;
}

function isSafeRel(rel: string): boolean {
  if (typeof rel !== 'string' || !rel) return false;
  if (rel.startsWith('/') || rel.startsWith('\\')) return false;
  return rel.split('/').every((seg) => seg !== '' && seg !== '.' && seg !== '..');
}

function resolveUnder(root: string, rel: string): string {
  if (!isSafeRel(rel)) throw new Error(`unsafe path: ${rel}`);
  const cleanRoot = path.resolve(root);
  const full = path.resolve(cleanRoot, ...rel.split('/'));
  if (!full.startsWith(`${cleanRoot}${path.sep}`)) {
    throw new Error(`path escapes the sync root: ${rel}`);
  }
  return full;
}

async function scanTree(root: string, exclusions: string[], maxFileBytes: number, allowMissing = false): Promise<ScanResult> {
  const excluded = new Set(exclusions);
  const out: ScanResult = { files: [], symlinksSkipped: 0, largeSkipped: [] };
  const rootStat = await fsp.lstat(root).catch(() => null);
  if (!rootStat) {
    if (allowMissing) return out;
    throw new Error(`directory does not exist: ${root}`);
  }
  if (!rootStat.isDirectory()) throw new Error(`not a directory: ${root}`);

  const walk = async (dir: string, prefix: string): Promise<void> => {
    let entries: fs.Dirent[];
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch (err: any) {
      throw new Error(`cannot read ${dir}: ${err?.message || err}`);
    }
    for (const e of entries) {
      if (excluded.has(e.name)) continue;
      const full = path.join(dir, e.name);
      const rel = prefix ? `${prefix}/${e.name}` : e.name;
      if (e.isSymbolicLink()) {
        out.symlinksSkipped += 1;
        continue;
      }
      if (e.isDirectory()) {
        await walk(full, rel);
        continue;
      }
      if (!e.isFile()) continue;
      let st: fs.Stats;
      try {
        st = await fsp.lstat(full);
      } catch {
        continue;
      }
      if (st.size > maxFileBytes) {
        out.largeSkipped.push({ rel, size: st.size });
        continue;
      }
      out.files.push({ rel, size: st.size, mtimeMs: Math.floor(st.mtimeMs), mode: st.mode & 0o777 });
      if (out.files.length + out.largeSkipped.length > MAX_FILES) {
        throw new Error(`more than ${MAX_FILES} files under ${root} — refusing to sync a tree this large`);
      }
    }
  };
  await walk(root, '');
  return out;
}

async function hashFile(full: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = createHash('sha256');
    const stream = fs.createReadStream(full);
    stream.on('data', (c) => h.update(c));
    stream.on('end', () => resolve(h.digest('hex')));
    stream.on('error', reject);
  });
}

function tmpPathFor(finalPath: string, token: string): string {
  return path.join(path.dirname(finalPath), `.${path.basename(finalPath)}.${token}.frontier-sync-tmp`);
}

async function applyMeta(file: string, mtimeMs: number, mode: number): Promise<void> {
  if (Number.isFinite(mode)) await fsp.chmod(file, mode & 0o777).catch(() => { /* fs may not support modes */ });
  if (Number.isFinite(mtimeMs)) {
    const t = new Date(mtimeMs);
    await fsp.utimes(file, t, t).catch(() => { /* fs may not support utimes */ });
  }
}

// Remove now-empty parent directories of deleted rels, deepest-first, never
// touching the root itself. rmdir on a non-empty dir just fails — that is the
// stop condition, not an error.
async function pruneEmptyDirs(root: string, rels: string[]): Promise<void> {
  const dirs = new Set<string>();
  for (const rel of rels) {
    let parent = path.dirname(rel);
    while (parent && parent !== '.') {
      dirs.add(parent);
      parent = path.dirname(parent);
    }
  }
  const ordered = Array.from(dirs).sort((a, b) => b.split('/').length - a.split('/').length);
  for (const rel of ordered) {
    try {
      await fsp.rmdir(resolveUnder(root, rel));
    } catch { /* not empty / already gone */ }
  }
}

async function copyLocal(src: string, dest: string, mtimeMs: number, mode: number): Promise<void> {
  await fsp.mkdir(path.dirname(dest), { recursive: true });
  const tmp = tmpPathFor(dest, Math.random().toString(36).slice(2, 8));
  try {
    await fsp.copyFile(src, tmp);
    await applyMeta(tmp, mtimeMs, mode);
    await fsp.rename(tmp, dest);
  } catch (err) {
    await fsp.unlink(tmp).catch(() => { /* never created */ });
    throw err;
  }
}

async function mirrorLocal(opts: {
  sourceRoot: string;
  targetRoot: string;
  exclusions: string[];
  maxFileBytes: number;
}): Promise<{
  copied: number; deleted: number; bytes: number;
  symlinksSkipped: number; largeSkipped: Array<{ rel: string; size: number }>;
  warnings: string[];
}> {
  const source = await scanTree(opts.sourceRoot, opts.exclusions, opts.maxFileBytes);
  await fsp.mkdir(opts.targetRoot, { recursive: true });
  const target = await scanTree(opts.targetRoot, opts.exclusions, opts.maxFileBytes, true);
  const targetByRel = new Map(target.files.map((f) => [f.rel, f]));

  const warnings: string[] = [];
  let copied = 0;
  let bytes = 0;
  for (const f of source.files) {
    const existing = targetByRel.get(f.rel);
    let needsCopy = true;
    if (existing && existing.size === f.size) {
      if (Math.floor(existing.mtimeMs / 1000) === Math.floor(f.mtimeMs / 1000)) {
        needsCopy = false;
      } else {
        const srcFull = resolveUnder(opts.sourceRoot, f.rel);
        const tgtFull = resolveUnder(opts.targetRoot, f.rel);
        try {
          const [a, b] = await Promise.all([hashFile(srcFull), hashFile(tgtFull)]);
          if (a === b) {
            needsCopy = false;
            await applyMeta(tgtFull, f.mtimeMs, f.mode);
          }
        } catch { /* unreadable — fall through to the copy attempt */ }
      }
    }
    if (!needsCopy) continue;
    try {
      await copyLocal(resolveUnder(opts.sourceRoot, f.rel), resolveUnder(opts.targetRoot, f.rel), f.mtimeMs, f.mode);
      copied += 1;
      bytes += f.size;
    } catch (err: any) {
      warnings.push(`${f.rel}: ${err?.message || err}`);
    }
  }

  const sourceRels = new Set(source.files.map((f) => f.rel));
  const toDelete = target.files.filter((f) => !sourceRels.has(f.rel)).map((f) => f.rel);
  let deleted = 0;
  for (const rel of toDelete) {
    try {
      await fsp.unlink(resolveUnder(opts.targetRoot, rel));
      deleted += 1;
    } catch (err: any) {
      warnings.push(`delete ${rel}: ${err?.message || err}`);
    }
  }
  await pruneEmptyDirs(opts.targetRoot, toDelete);

  return {
    copied, deleted, bytes,
    symlinksSkipped: source.symlinksSkipped,
    largeSkipped: source.largeSkipped,
    warnings,
  };
}

export function register(provider: WorkerProvider): void {
  const worker = provider.version(1);
  const { channel } = worker;

  interface OpenWrite {
    fd: fsp.FileHandle;
    tmpPath: string;
    finalPath: string;
    lastTouch: number;
  }
  const writes = new Map<string, OpenWrite>();

  async function discardWrite(writeId: string): Promise<void> {
    const w = writes.get(writeId);
    if (!w) return;
    writes.delete(writeId);
    await w.fd.close().catch(() => { /* already closed */ });
    await fsp.unlink(w.tmpPath).catch(() => { /* already gone */ });
  }

  // A host that vanished mid-transfer leaves open temp files behind — sweep
  // writes nothing has touched for a while.
  setInterval(() => {
    const now = Date.now();
    for (const [writeId, w] of Array.from(writes.entries())) {
      if (now - w.lastTouch > WRITE_IDLE_MAX_MS) {
        console.log(`[dir-sync-worker] sweeping stale write ${writeId} (${w.finalPath})`);
        void discardWrite(writeId);
      }
    }
  }, WRITE_IDLE_SWEEP_MS).unref?.();

  function respond(reqId: string, op: string, body: Record<string, any>): void {
    channel.send({ op: `${op}.res`, reqId, ...body });
  }

  const handlers: Record<string, (msg: any) => Promise<void>> = {
    async scan(msg) {
      const result = await scanTree(
        String(msg.root || ''),
        Array.isArray(msg.exclusions) ? msg.exclusions : [],
        Number(msg.maxFileBytes) || Infinity,
        msg.allowMissing === true,
      );
      let i = 0;
      while (result.files.length - i > SCAN_BATCH) {
        respond(msg.reqId, 'scan', { files: result.files.slice(i, i + SCAN_BATCH), done: false });
        i += SCAN_BATCH;
      }
      respond(msg.reqId, 'scan', {
        files: result.files.slice(i),
        done: true,
        symlinksSkipped: result.symlinksSkipped,
        largeSkipped: result.largeSkipped,
      });
    },

    async hash(msg) {
      const root = String(msg.root || '');
      const hashes: Record<string, string> = {};
      const errors: Record<string, string> = {};
      for (const rel of Array.isArray(msg.rels) ? msg.rels : []) {
        try {
          hashes[rel] = await hashFile(resolveUnder(root, rel));
        } catch (err: any) {
          errors[rel] = err?.message || String(err);
        }
      }
      respond(msg.reqId, 'hash', { hashes, errors });
    },

    async read(msg) {
      const full = resolveUnder(String(msg.root || ''), String(msg.rel || ''));
      const offset = Number(msg.offset) || 0;
      const length = Math.max(0, Number(msg.length) || 0);
      const fd = await fsp.open(full, 'r');
      try {
        const buf = Buffer.alloc(length);
        const { bytesRead } = await fd.read(buf, 0, length, offset);
        respond(msg.reqId, 'read', { dataB64: buf.subarray(0, bytesRead).toString('base64'), bytes: bytesRead });
      } finally {
        await fd.close();
      }
    },

    async 'write.open'(msg) {
      const writeId = String(msg.writeId || '');
      if (!writeId) throw new Error('writeId required');
      const finalPath = resolveUnder(String(msg.root || ''), String(msg.rel || ''));
      await fsp.mkdir(path.dirname(finalPath), { recursive: true });
      const tmpPath = tmpPathFor(finalPath, writeId.slice(-6));
      const fd = await fsp.open(tmpPath, 'w');
      writes.set(writeId, { fd, tmpPath, finalPath, lastTouch: Date.now() });
      respond(msg.reqId, 'write.open', {});
    },

    async 'write.chunk'(msg) {
      const w = writes.get(String(msg.writeId || ''));
      if (!w) throw new Error('write not open (aborted or swept)');
      w.lastTouch = Date.now();
      const buf = Buffer.from(String(msg.dataB64 || ''), 'base64');
      await w.fd.write(buf, 0, buf.length, Number(msg.offset) || 0);
      respond(msg.reqId, 'write.chunk', {});
    },

    async 'write.close'(msg) {
      const writeId = String(msg.writeId || '');
      const w = writes.get(writeId);
      if (!w) throw new Error('write not open (aborted or swept)');
      writes.delete(writeId);
      try {
        await w.fd.close();
        await applyMeta(w.tmpPath, Number(msg.mtimeMs), Number(msg.mode));
        await fsp.rename(w.tmpPath, w.finalPath);
      } catch (err) {
        await fsp.unlink(w.tmpPath).catch(() => { /* already gone */ });
        throw err;
      }
      respond(msg.reqId, 'write.close', {});
    },

    async delete(msg) {
      const root = String(msg.root || '');
      const rels = Array.isArray(msg.rels) ? msg.rels : [];
      let deleted = 0;
      const errors: string[] = [];
      const gone: string[] = [];
      for (const rel of rels) {
        try {
          await fsp.unlink(resolveUnder(root, rel));
          deleted += 1;
          gone.push(rel);
        } catch (err: any) {
          errors.push(`delete ${rel}: ${err?.message || err}`);
        }
      }
      await pruneEmptyDirs(root, gone);
      respond(msg.reqId, 'delete', { deleted, errors });
    },

    async touch(msg) {
      const root = String(msg.root || '');
      for (const item of Array.isArray(msg.items) ? msg.items : []) {
        try {
          const full = resolveUnder(root, String(item?.rel || ''));
          const t = new Date(Number(item?.mtimeMs) || 0);
          await fsp.utimes(full, t, t);
        } catch { /* file raced away — the next scan re-diffs it */ }
      }
      respond(msg.reqId, 'touch', {});
    },

    async mirror(msg) {
      const result = await mirrorLocal({
        sourceRoot: String(msg.sourceRoot || ''),
        targetRoot: String(msg.targetRoot || ''),
        exclusions: Array.isArray(msg.exclusions) ? msg.exclusions : [],
        maxFileBytes: Number(msg.maxFileBytes) || Infinity,
      });
      respond(msg.reqId, 'mirror', result);
    },
  };

  channel.onMessage((msg: any) => {
    const op = typeof msg?.op === 'string' ? msg.op : '';
    if (op === 'write.abort') {
      void discardWrite(String(msg.writeId || ''));
      return;
    }
    const handler = handlers[op];
    const reqId = typeof msg?.reqId === 'string' ? msg.reqId : '';
    if (!handler || !reqId) return;
    handler(msg).catch((err: any) => {
      respond(reqId, op, { error: err?.message || String(err) });
    });
  });
}
