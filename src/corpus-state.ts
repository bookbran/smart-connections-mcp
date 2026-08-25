/**
 * The one place that decides whether evidence is safe to use (tracker 1.2, 1.5, 1.6).
 *
 * -- The bug this replaces --
 *
 * Retrieval treated "Smart Connections has an entry for this path" as a proxy
 * for "this note's current contents are represented in retrieval." Those are
 * different statements. Measured on this vault on 2026-08-25 they disagreed for
 * 509 of 525 indexed notes, by a median of 67 days, while the health check
 * reported `unsearchable: 0` the entire time, because both sides of that
 * subtraction were computed from the same two indexes. A check built that way
 * cannot fail, which is a different thing from passing.
 *
 * -- The replacement, in one sentence --
 *
 * Disk presence establishes EXISTENCE. A verified-current vector establishes
 * SEMANTIC COVERAGE. They are separate sets, computed separately, and every
 * later question is a set operation between them.
 *
 * -- Why this is a snapshot and not a startup fact --
 *
 * A long-lived server whose corpus was correct at launch is a smaller version of
 * the same bug: `freshnessVerified: true` would mean "was fresh at some
 * unspecified moment since boot," which is weaker than any agent reading it will
 * assume. So the state carries a `generation` and a `verifiedAt`, and is
 * reconciled before each retrieval operation and each health check.
 *
 * The cost is re-reading and re-hashing the vault. Measured on ~700 notes it is
 * small next to a single embedding call, which is the comparison that matters.
 * Correctness first; optimize the mechanism later against timing data, and never
 * by weakening the contract. In particular there is NO mtime or size skip: a
 * same-size edit with a preserved timestamp would make that skip claim
 * false-fresh, which is the exact failure being removed.
 *
 * -- Errors are a classification, not a silence --
 *
 * A file that exists but cannot be read is neither absent nor covered. Letting
 * it vanish from `onDisk` would understate the vault; letting it count as
 * covered would overstate retrieval. It gets its own classification, and any
 * unresolved corpus error prevents `freshnessVerified` and `coverageComplete`
 * from being true. Same philosophy as not letting the health check grade its own
 * homework.
 */

import { readdirSync, readFileSync, statSync, promises as fsp } from 'fs';
import { join, relative, sep } from 'path';
import { canonicalPath, caseFold, isMarkdownPath } from './canonical-path.js';
import { CONTENT_HASH_ALGORITHM, canonicalContentHash, canonicalizeMarkdown } from './content-hash.js';
import { verifyPluginSource, type PluginVectorVerdict } from './smart-connections-hash.js';
import { loadSupplementalCache, entryIsCurrent } from './supplemental-store.js';
import type { SmartConnectionsLoader } from './smart-connections-loader.js';

/** Mirrors what Smart Connections itself skips, plus our own bookkeeping. */
const SKIP_DIRS = new Set([
  '.obsidian',
  '.smart-env',
  '.git',
  '.trash',
  'node_modules',
  '.stfolder',
]);

/**
 * Below this many characters of canonical text a note carries no retrievable
 * meaning and is never embedded. It is therefore INELIGIBLE rather than
 * uncovered: counting it as pending would make `coverageComplete` unreachable
 * forever on any vault holding a stub, and a completeness flag that can never be
 * true is a completeness flag nobody reads.
 */
export const MIN_EMBEDDABLE_CHARS = 50;

export type CorpusErrorScope = 'inventory' | 'read' | 'hash' | 'embed';

export interface CorpusError {
  scope: CorpusErrorScope;
  path?: string;
  message: string;
}

export interface InventoryEntry {
  /** Canonical, NFC-normalized, forward-slashed, vault-relative. The corpus key. */
  path: string;
  /**
   * Exactly what the filesystem handed us. Used for I/O, because NFC
   * normalization is a comparison convenience and macOS wants its own NFD
   * spelling back when you go to open the file.
   */
  diskPath: string;
  size: number;
  mtimeMs: number;
}

/**
 * What exists on disk. The ONLY thing allowed to answer "does this note exist."
 */
export class VaultInventory {
  private readonly entries = new Map<string, InventoryEntry>();
  private readonly byFold = new Map<string, string>();
  readonly errors: CorpusError[] = [];

  private constructor(readonly vaultPath: string) {}

  static build(vaultPath: string): VaultInventory {
    const inv = new VaultInventory(vaultPath);
    inv.walk(vaultPath);
    return inv;
  }

  private walk(dir: string): void {
    let dirents;
    try {
      dirents = readdirSync(dir, { withFileTypes: true });
    } catch (e) {
      // A directory we cannot list is a hole in the inventory, and a hole in the
      // inventory is a hole in every set computed from it. Recorded, not
      // swallowed: it is what stops `coverageComplete` claiming completeness it
      // did not earn.
      this.errors.push({
        scope: 'inventory',
        path: relative(this.vaultPath, dir).split(sep).join('/') || '.',
        message: e instanceof Error ? e.message : String(e),
      });
      return;
    }

    for (const entry of dirents) {
      if (SKIP_DIRS.has(entry.name)) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        this.walk(full);
        continue;
      }
      if (!entry.isFile()) continue;

      const diskPath = relative(this.vaultPath, full).split(sep).join('/');
      const path = canonicalPath(diskPath);
      if (!path || !isMarkdownPath(path)) continue;

      // stat is for REPORTING only. Freshness never reads it, on purpose: see
      // `content-hash.ts` for why mtime and size are not a freshness signal.
      let size = -1;
      let mtimeMs = -1;
      try {
        const st = statSync(full);
        size = st.size;
        mtimeMs = st.mtimeMs;
      } catch {
        // The file is listed, so it exists. Its metadata being unavailable does
        // not make it absent, and reconciliation classifies it properly when the
        // read fails there too.
      }

      this.entries.set(path, { path, diskPath, size, mtimeMs });
      this.byFold.set(caseFold(path), path);
    }
  }

  has(path: string): boolean {
    return this.entries.has(path);
  }

  get(path: string): InventoryEntry | undefined {
    return this.entries.get(path);
  }

  get size(): number {
    return this.entries.size;
  }

  paths(): string[] {
    return Array.from(this.entries.keys());
  }

  values(): InventoryEntry[] {
    return Array.from(this.entries.values());
  }

  /**
   * Map a path from any producer onto the spelling the disk uses, or null.
   *
   * This is the single place a capitalization disagreement is allowed to be
   * resolved. Everything downstream then holds one spelling, which is both the
   * set key and the string that actually opens the file. Doing it anywhere else
   * would mean two producers each "handling" case and still disagreeing.
   */
  resolve(rawPath: string): string | null {
    const path = canonicalPath(rawPath);
    if (!path) return null;
    if (this.entries.has(path)) return path;
    return this.byFold.get(caseFold(path)) ?? null;
  }
}

export interface CorpusState {
  /** Increments on every reconciliation, so a caller can tell two snapshots apart. */
  generation: number;
  /** ISO timestamp of this reconciliation. A boolean you cannot date is worth much less. */
  verifiedAt: string;
  vaultPath: string;
  contentHashAlgorithm: string;

  /** Every markdown file found, readable or not. Existence, nothing more. */
  onDisk: Map<string, InventoryEntry>;
  /** Canonical content hash per note we could read. */
  contentHashes: Map<string, string>;
  /**
   * Canonical text, kept from the reconciliation read.
   *
   * Reconciliation already reads and canonicalizes every note in order to hash
   * it, so lexical search over the whole vault costs nothing extra rather than a
   * second full read per query. Capped by total bytes: past the cap a note is
   * simply re-read on demand, which is slower and still complete. Lexical
   * coverage must never depend on how much memory we felt like using.
   */
  text: Map<string, string>;
  /**
   * Map any producer's spelling of a path onto the disk's. Bound to this
   * snapshot's inventory so callers do not have to carry the inventory around.
   */
  resolvePath: (rawPath: string) => string | null;

  /** Notes big enough to carry meaning, and therefore expected to have a vector. */
  eligible: Set<string>;
  /** Notes deliberately never embedded, so they never count against coverage. */
  ineligible: Set<string>;

  /** Plugin sources whose vector provably matches current disk content. */
  pluginFresh: Set<string>;
  /** Plugin sources present on disk whose vector does not. */
  pluginStale: Set<string>;
  /** Plugin sources with no file behind them any more. */
  pluginPhantoms: Set<string>;
  /** Plugin sources whose file exists but could not be read to check. */
  pluginUnreadable: Set<string>;
  /** Why each plugin source was accepted or refused. Diagnostics only. */
  pluginVerdicts: Map<string, PluginVectorVerdict>;

  /** Supplemental vectors whose stored fingerprint matches current disk content. */
  supplementalFresh: Set<string>;

  /** Eligible notes with SOME verified-current vector, from either source. */
  semanticCurrent: Set<string>;
  /** Eligible notes with none. This is what the indexer consumes. */
  semanticPending: Set<string>;

  /** Files that exist and could not be read. Neither absent nor covered. */
  unreadable: Set<string>;

  errors: {
    inventory: CorpusError[];
    read: CorpusError[];
    hash: CorpusError[];
    embed: CorpusError[];
  };
}

/** True when nothing about this snapshot is unaccounted for. */
export function corpusIsClean(state: CorpusState): boolean {
  return (
    state.errors.inventory.length === 0 &&
    state.errors.read.length === 0 &&
    state.errors.hash.length === 0 &&
    state.errors.embed.length === 0
  );
}

/** How many files are read at once during reconciliation. */
const READ_CONCURRENCY = 24;

/**
 * How much canonical text a snapshot keeps in memory for lexical search.
 *
 * 64M characters covers a vault far larger than any this has run on. Past it,
 * notes are re-read on demand: slower, never less complete. A retrieval corpus
 * that silently shrank to fit a memory budget would be the same class of lie as
 * the one being fixed.
 */
const TEXT_CACHE_BUDGET_CHARS = 64 * 1024 * 1024;

/**
 * Canonical text for a note: from the snapshot when it is held, from disk when
 * it is not. Returns null only when the note cannot be read at all.
 */
export function readCanonicalText(state: CorpusState, path: string): string | null {
  const held = state.text.get(path);
  if (held !== undefined) return held;
  const entry = state.onDisk.get(path);
  if (!entry) return null;
  try {
    return canonicalizeMarkdown(readFileSync(join(state.vaultPath, entry.diskPath), 'utf-8'));
  } catch {
    return null;
  }
}

async function mapWithConcurrency<T>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<void>
): Promise<void> {
  let next = 0;
  const width = Math.max(1, Math.min(limit, items.length));
  const workers = new Array(width).fill(0).map(async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      await fn(items[i]);
    }
  });
  await Promise.all(workers);
}

/**
 * Builds and re-builds the snapshot.
 *
 * Embedding failures are held here between reconciliations rather than
 * recomputed, because they are the one corpus fact that is not derivable from
 * disk: a note whose embedding call failed looks exactly like a note that has
 * not been reached yet, and the difference matters to whoever is deciding
 * whether coverage is converging or stuck.
 */
export class CorpusReconciler {
  private generation = 0;
  private inFlight: Promise<CorpusState> | null = null;
  private latest: CorpusState | null = null;
  private readonly embedErrors = new Map<string, CorpusError>();

  constructor(
    private readonly vaultPath: string,
    private readonly loader: SmartConnectionsLoader
  ) {}

  /** The most recent snapshot, or null before the first reconciliation. */
  peek(): CorpusState | null {
    return this.latest;
  }

  recordEmbedFailure(path: string, message: string): void {
    this.embedErrors.set(path, { scope: 'embed', path, message });
  }

  clearEmbedFailure(path: string): void {
    this.embedErrors.delete(path);
  }

  /**
   * Reconcile and return the current snapshot.
   *
   * Concurrent callers within one reconciliation share it. That is not a
   * staleness weakening: it stops four tool calls in the same tick from running
   * four full vault hashes for one moment in time. Every caller still gets a
   * snapshot verified no earlier than when it asked.
   */
  async reconcile(): Promise<CorpusState> {
    if (this.inFlight) return this.inFlight;
    const run = this.doReconcile();
    this.inFlight = run;
    try {
      return await run;
    } finally {
      if (this.inFlight === run) this.inFlight = null;
    }
  }

  private async doReconcile(): Promise<CorpusState> {
    const inventory = VaultInventory.build(this.vaultPath);
    const cache = loadSupplementalCache(this.vaultPath);
    const modelKey = this.loader.getEmbeddingModelKey();

    const state: CorpusState = {
      generation: ++this.generation,
      verifiedAt: new Date().toISOString(),
      vaultPath: this.vaultPath,
      contentHashAlgorithm: CONTENT_HASH_ALGORITHM,
      onDisk: new Map(),
      contentHashes: new Map(),
      text: new Map(),
      resolvePath: (rawPath: string) => inventory.resolve(rawPath),
      eligible: new Set(),
      ineligible: new Set(),
      pluginFresh: new Set(),
      pluginStale: new Set(),
      pluginPhantoms: new Set(),
      pluginUnreadable: new Set(),
      pluginVerdicts: new Map(),
      supplementalFresh: new Set(),
      semanticCurrent: new Set(),
      semanticPending: new Set(),
      unreadable: new Set(),
      errors: {
        inventory: [...inventory.errors],
        read: [],
        hash: [],
        embed: Array.from(this.embedErrors.values()),
      },
    };

    for (const entry of inventory.values()) state.onDisk.set(entry.path, entry);

    let textBytes = 0;

    // Plugin sources, re-keyed onto disk spelling. A source whose path resolves
    // to nothing on disk is a phantom: the note was deleted or renamed and the
    // index still carries its vector. Nine of these were sitting in this vault
    // when the bug was found, from a `cursor-skills/` folder deleted months ago.
    const pluginByPath = new Map<string, string>();
    for (const rawPath of this.loader.getSources().keys()) {
      const resolved = inventory.resolve(rawPath);
      if (!resolved) {
        const canon = canonicalPath(rawPath);
        if (canon) {
          state.pluginPhantoms.add(canon);
          state.pluginVerdicts.set(canon, 'no-vector');
        }
        continue;
      }
      pluginByPath.set(resolved, rawPath);
    }

    await mapWithConcurrency(inventory.values(), READ_CONCURRENCY, async (entry) => {
      const abs = join(this.vaultPath, entry.diskPath);
      let raw: string;
      try {
        raw = await fsp.readFile(abs, 'utf-8');
      } catch (e) {
        // Exists, cannot be read. Not absent, not covered.
        state.unreadable.add(entry.path);
        state.errors.read.push({
          scope: 'read',
          path: entry.path,
          message: e instanceof Error ? e.message : String(e),
        });
        if (pluginByPath.has(entry.path)) {
          state.pluginUnreadable.add(entry.path);
          state.pluginVerdicts.set(entry.path, 'no-fingerprint');
        }
        return;
      }

      let canonical: string;
      let hash: string;
      try {
        const computed = canonicalContentHash(raw);
        canonical = computed.canonical;
        hash = computed.hash;
      } catch (e) {
        // A hash failure is its own error class. Never silently fresh, and never
        // silently stale either: it is a thing that went wrong and says so.
        state.unreadable.add(entry.path);
        state.errors.hash.push({
          scope: 'hash',
          path: entry.path,
          message: e instanceof Error ? e.message : String(e),
        });
        return;
      }

      state.contentHashes.set(entry.path, hash);
      if (textBytes + canonical.length <= TEXT_CACHE_BUDGET_CHARS) {
        state.text.set(entry.path, canonical);
        textBytes += canonical.length;
      }

      if (canonical.trim().length < MIN_EMBEDDABLE_CHARS) {
        state.ineligible.add(entry.path);
      } else {
        state.eligible.add(entry.path);
      }

      // Plugin vectors verify against RAW content, because the plugin hashed raw
      // content including its line endings. Our own vectors verify against
      // canonical text instead, which is why a line-ending flip on another
      // machine costs us the plugin's work and never our own.
      const rawKey = pluginByPath.get(entry.path);
      if (rawKey !== undefined) {
        const verdict = verifyPluginSource(this.loader.getSource(rawKey), modelKey, raw);
        state.pluginVerdicts.set(entry.path, verdict);
        if (verdict === 'verified-current') state.pluginFresh.add(entry.path);
        else state.pluginStale.add(entry.path);
      }

      if (entryIsCurrent(cache.entries[entry.path], hash)) {
        state.supplementalFresh.add(entry.path);
      }
    });

    for (const path of state.eligible) {
      if (state.pluginFresh.has(path) || state.supplementalFresh.has(path)) {
        state.semanticCurrent.add(path);
      } else {
        state.semanticPending.add(path);
      }
    }

    this.latest = state;
    return state;
  }
}
