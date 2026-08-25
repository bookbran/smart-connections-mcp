/**
 * The only corpus retrieval is allowed to rank against (tracker 2.3, 5.1, 5.6).
 *
 * -- Why a facade rather than a filter at each call site --
 *
 * Filtering `pluginVectors()` and forgetting `getBlockVectors()` leaves the bug
 * fully intact, because `denseScores` takes the MAX across a note's evidence and
 * a stale block can be the strongest signal for a note. That is not a
 * hypothetical: on this vault, a stale note ranked 6th of 55 in the lexical
 * scorer for a literal phrase and still never appeared in fused output, because
 * its stale vector earned a terrible dense rank and RRF buried a lexical-only
 * hit under notes scoring in both lists. Dropping stale vectors does not merely
 * remove wrong answers, it RESTORES the lexical fallback path.
 *
 * So there is one object, it is built once per operation, and it holds only
 * vectors that a reconciled snapshot vouched for. Whole-note and block together,
 * plugin and supplemental together. A retrieval surface that wants evidence asks
 * this; nothing downstream re-derives freshness or reaches past it.
 *
 * -- Why nothing here can quietly regress --
 *
 * Six months from now somebody adds `find_related_projects()` and naturally
 * reaches for `loader.getSources()`, and this whole build silently unwinds in
 * one function. `test/no-raw-corpus-access.test.mjs` fails the build when a
 * retrieval module does that. Prose does not enforce anything; a failing test
 * does.
 */
import { type CorpusState } from './corpus-state.js';
import { type SupplementalIndex } from './vault-indexer.js';
import type { SmartConnectionsLoader } from './smart-connections-loader.js';
export interface BlockVector {
    heading: string;
    vec: number[];
}
export interface CurrentCorpus {
    /** The snapshot every set here was computed from. */
    state: CorpusState;
    /** Whole-note vectors, verified current. Plugin and supplemental merged. */
    noteVectors: Map<string, number[]>;
    /** Section-level vectors, verified current. Plugin blocks and our chunks merged. */
    sectionVectors: Map<string, BlockVector[]>;
    /** Notes with at least one rankable vector. */
    semanticSearchable: Set<string>;
    /** What the indexing pass did, for honest reporting. */
    supplemental: SupplementalIndex;
    /**
     * Heading names that can be trusted for a note (tracker 5.5).
     *
     * Plugin sources carry heading-to-line-range mappings, and once a file changes
     * those coordinates are exactly as suspect as the vectors built from them.
     * Only fresh sources contribute.
     */
    blockHeadings: Map<string, string[]>;
}
export interface CorpusOptions {
    /** Embed-call ceiling for the indexing pass inside this operation. */
    maxEmbeddings?: number;
    /** Pending notes to prefer, in order. */
    order?: string[];
    /** Skip indexing entirely and rank against what is already current. */
    skipIndexing?: boolean;
}
/**
 * Owns the reconciler and hands out corpora.
 *
 * `get()` reconciles EVERY time, which is the contract from tracker 1.6: a
 * server whose corpus was correct at launch is a smaller version of this bug.
 * Measured at ~300ms for 702 notes, which is small next to a single embedding
 * call, so correctness does not need an exception here.
 */
export declare class CorpusProvider {
    private readonly loader;
    private readonly vaultPath;
    private readonly reconciler;
    constructor(loader: SmartConnectionsLoader, vaultPath: string);
    /** For callers that need only the classification, with no embedding work. */
    snapshot(): Promise<CorpusState>;
    get(options?: CorpusOptions): Promise<CurrentCorpus>;
    private assemble;
}
//# sourceMappingURL=current-corpus.d.ts.map