/**
 * Where the vectors this server owns are kept, and what makes one trustworthy.
 *
 * Split out of `vault-indexer.ts` so the corpus classifier and the indexer can
 * both read it without importing each other. That circularity is not a build
 * technicality: the classifier has to know which supplemental vectors are
 * current in order to compute what still needs embedding, and the indexer has to
 * know what still needs embedding in order to produce vectors. Putting the store
 * underneath both is what keeps "is this current" a single answer.
 *
 * THE CACHE KEY IS THE CONTENT, NOT THE FILE. The previous version keyed reuse
 * on `size` and `mtime`. That is the bug this build exists to remove, one layer
 * down from where it was found. Every entry now carries the canonical content
 * hash of the exact text that was chunked and embedded, plus the id of the
 * algorithm that produced it.
 *
 * LEGACY ENTRIES ARE DROPPED, ONCE. An entry written before this change has no
 * fingerprint, so there is no way to learn what content produced its vector.
 * Comparing a fresh hash against nothing proves nothing, and bootstrapping trust
 * from metadata already judged non-authoritative is how the original bug
 * happened. They are discarded on load and re-embedded through the normal path.
 * The cost is one full re-embed. The alternative is keeping vectors we cannot
 * vouch for, which is the thing being fixed.
 */
export declare const SUPPLEMENTAL_CACHE_FILE = ".smart-env/mcp-supplemental.json";
/**
 * Bumped when the on-disk shape changes in a way older readers would
 * misinterpret. Version 2 introduces content fingerprints; version 1 and the
 * unversioned original are dropped rather than guessed at.
 */
export declare const SUPPLEMENTAL_CACHE_VERSION = 2;
/**
 * Bump whenever chunking changes shape. The content hash cannot detect it: the
 * file is identical and the chunks derived from it are not, so without this an
 * unchanged note keeps vectors built by the old splitter forever. Learned by
 * shipping a chunker fix that would otherwise have reached only the notes Dan
 * happened to edit afterwards.
 */
export declare const CHUNKER_VERSION = 3;
export interface SupplementalEntry {
    /** Whole-note vector, so a note still matches on its overall gist. */
    vec: number[];
    /** Per-section vectors, the ones that make a long note's body findable. */
    sections: number[][];
    /** Which splitter produced `sections`. */
    chunker: number;
    /** Canonical hash of the exact text that was chunked and embedded. */
    contentHash: string;
    /** Which canonicalization produced `contentHash`. */
    contentHashAlgorithm: string;
    /** Epoch ms, for reporting only. Never a freshness input. */
    embeddedAt: number;
}
export interface SupplementalCache {
    version: number;
    algorithm: string;
    chunker: number;
    entries: Record<string, SupplementalEntry>;
}
/**
 * A cache entry is usable only when it can prove which content it came from.
 *
 * Four independent reasons to refuse, and all of them mean the same thing: we
 * cannot vouch for this vector, so it does not get ranked.
 */
export declare function entryIsCurrent(entry: SupplementalEntry | undefined, currentHash: string | undefined): boolean;
export declare function loadSupplementalCache(vaultPath: string): SupplementalCache;
export declare function saveSupplementalCache(vaultPath: string, cache: SupplementalCache): void;
//# sourceMappingURL=supplemental-store.d.ts.map