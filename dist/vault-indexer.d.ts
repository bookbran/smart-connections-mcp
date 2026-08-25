/**
 * Producing the vectors this server owns (tracker 2.1, 2.2).
 *
 * -- What changed, and why it is not a refactor --
 *
 * This used to embed "every note the plugin has not indexed", expressed as
 * `!knownPaths.has(p)`. That predicate answers a question about the INDEX, and
 * the question that matters is about the NOTE: does this note have a vector
 * built from the text currently on disk. A note the plugin indexed in June and
 * the member edited in August passed `knownPaths.has(p)` and was skipped, so its
 * June vector kept answering queries as if it were current.
 *
 * The indexer no longer decides any of that. It consumes `semanticPending` from
 * the corpus snapshot, which is a set operation against one definition of
 * freshness rather than a second implementation of it. That is the whole point
 * of Phase 1 existing first: without it, this file would have grown its own
 * freshness check and the next tool would have grown a third.
 *
 * -- The race this closes (tracker 2.2) --
 *
 *     read file -> hash A -> begin embedding -> member edits file (content B)
 *               -> embedding finishes -> vector installed as "current"   WRONG
 *
 * Embedding a 700-note vault takes minutes, and a member editing a note during
 * that window is not an exotic case, it is Tuesday. The fix has two halves:
 *
 *   1. Read the content ONCE, canonicalize it, hash THAT SAME TEXT, chunk THAT
 *      SAME TEXT, embed those chunks. There is exactly one string in play, so
 *      there is no opportunity to hash one thing and embed another.
 *   2. Before treating the result as current, read the file again. If its hash
 *      moved while we were working, the vector is still cached under the hash it
 *      was actually built from, so it costs nothing and may be useful if the
 *      member reverts, but it is NOT reported as current and the note stays
 *      pending.
 *
 * The invariant, stated once: a current vector carries the fingerprint of
 * exactly the content it was built from, and that fingerprint still equals disk.
 *
 * -- Chunking --
 *
 * Notes are split on markdown headings and each section embedded separately,
 * mirroring what Smart Connections does and the actual reason its index is
 * better. A note vector is truncated to the model's window, so on a vault of
 * ordinary multi-thousand-character notes it represents the opening and nothing
 * else. Measured on this vault, retrieving a note from a passage in its own
 * body: recall@1 of 15% on note vectors against 57% on per-section vectors.
 */
import type { CorpusState } from './corpus-state.js';
/**
 * Budget in EMBED CALLS, not notes, because a note costs one call for itself
 * plus one per heading section. Measured here at 10.6 sections per note, so a
 * per-note cap of 2000 quietly became roughly 21,000 calls and the old "about
 * thirty seconds" promise became minutes, landing on a member's very first
 * query.
 *
 * Never widen this as the fix for a backlog. A backlog gets better scheduling
 * and a deliberate catch-up path; see `refresh_search_index`.
 */
export declare const DEFAULT_EMBED_BUDGET = 3000;
export interface SupplementalIndex {
    /** Whole-note vectors that are verified current as of this run. */
    vectors: Map<string, number[]>;
    /** Per-section vectors by note path, mirroring the plugin's block index. */
    sections: Map<string, number[][]>;
    /** Notes reached this run. */
    attempted: number;
    /** Notes embedded this run. */
    newlyEmbedded: number;
    /** Notes served from cache without an embed call. */
    alreadyCurrent: number;
    /** Notes whose embedding failed. */
    failed: number;
    /** Notes edited WHILE being embedded, so their new vector is not yet current. */
    raced: number;
    /** Pending notes this run did not reach, because the budget ran out. */
    remaining: number;
    /** Embed calls spent. */
    embedCalls: number;
    /** Per-path failure reasons, for the corpus error classes. */
    failures: Array<{
        path: string;
        message: string;
    }>;
}
export declare function emptySupplementalIndex(): SupplementalIndex;
/**
 * Split a note into heading-delimited sections small enough to embed whole.
 *
 * The note's path rides on every chunk: location and filename carry real topic
 * signal, and a bare section body often does not say what it is about.
 *
 * Expects CANONICAL text. The `\r` handling that used to live here is gone
 * because canonicalization already removed it, and two places normalizing line
 * endings is two places that can disagree about what was hashed.
 */
export declare function splitIntoSections(relPath: string, text: string, maxChars?: number): string[];
export interface IndexOptions {
    /** Hard cap on embed calls for this run. */
    maxEmbeddings?: number;
    /**
     * Which pending notes to work, in priority order. Defaults to every pending
     * note in the snapshot. Phase 7 uses this to put query-relevant and
     * recently-touched notes first, because directory order makes a note edited
     * today wait behind hundreds of unrelated ones.
     */
    order?: string[];
    /** Called for each note whose embedding failed, so the corpus can record it. */
    onFailure?: (path: string, message: string) => void;
    /** Called for each note that succeeded, so a stale embed error can be cleared. */
    onSuccess?: (path: string) => void;
}
/**
 * Load every current supplemental vector, and embed as much of the pending set
 * as the budget allows.
 *
 * Note what is NOT here any more: there is no `knownPaths`, no `statSync`, no
 * size comparison and no mtime comparison. Freshness arrives already decided.
 */
export declare function buildSupplementalIndex(vaultPath: string, state: CorpusState, options?: IndexOptions): Promise<SupplementalIndex>;
//# sourceMappingURL=vault-indexer.d.ts.map