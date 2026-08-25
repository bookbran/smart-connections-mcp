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
import { type PluginVectorVerdict } from './smart-connections-hash.js';
import type { SmartConnectionsLoader } from './smart-connections-loader.js';
/**
 * Below this many characters of canonical text a note carries no retrievable
 * meaning and is never embedded. It is therefore INELIGIBLE rather than
 * uncovered: counting it as pending would make `coverageComplete` unreachable
 * forever on any vault holding a stub, and a completeness flag that can never be
 * true is a completeness flag nobody reads.
 */
export declare const MIN_EMBEDDABLE_CHARS = 50;
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
export declare class VaultInventory {
    readonly vaultPath: string;
    private readonly entries;
    private readonly byFold;
    readonly errors: CorpusError[];
    private constructor();
    static build(vaultPath: string): VaultInventory;
    private walk;
    has(path: string): boolean;
    get(path: string): InventoryEntry | undefined;
    get size(): number;
    paths(): string[];
    values(): InventoryEntry[];
    /**
     * Map a path from any producer onto the spelling the disk uses, or null.
     *
     * This is the single place a capitalization disagreement is allowed to be
     * resolved. Everything downstream then holds one spelling, which is both the
     * set key and the string that actually opens the file. Doing it anywhere else
     * would mean two producers each "handling" case and still disagreeing.
     */
    resolve(rawPath: string): string | null;
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
export declare function corpusIsClean(state: CorpusState): boolean;
/**
 * Builds and re-builds the snapshot.
 *
 * Embedding failures are held here between reconciliations rather than
 * recomputed, because they are the one corpus fact that is not derivable from
 * disk: a note whose embedding call failed looks exactly like a note that has
 * not been reached yet, and the difference matters to whoever is deciding
 * whether coverage is converging or stuck.
 */
export declare class CorpusReconciler {
    private readonly vaultPath;
    private readonly loader;
    private generation;
    private inFlight;
    private latest;
    private readonly embedErrors;
    constructor(vaultPath: string, loader: SmartConnectionsLoader);
    /** The most recent snapshot, or null before the first reconciliation. */
    peek(): CorpusState | null;
    recordEmbedFailure(path: string, message: string): void;
    clearEmbedFailure(path: string): void;
    /**
     * Reconcile and return the current snapshot.
     *
     * Concurrent callers within one reconciliation share it. That is not a
     * staleness weakening: it stops four tool calls in the same tick from running
     * four full vault hashes for one moment in time. Every caller still gets a
     * snapshot verified no earlier than when it asked.
     */
    reconcile(): Promise<CorpusState>;
    private doReconcile;
}
//# sourceMappingURL=corpus-state.d.ts.map