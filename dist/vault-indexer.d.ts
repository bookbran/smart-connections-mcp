/**
 * Embedding the notes Smart Connections hasn't got to yet.
 *
 * WHY. Smart Connections only re-embeds while Obsidian is open. Anything written
 * since it last ran is absent from `.smart-env`, so semantic search silently
 * skips it: `get_similar_notes` answers "Note not found" and a query search
 * returns the second-best note without ever mentioning that the best one was
 * invisible. That is the same failure shape as a search tool returning `[]`
 * because of a bad threshold. It looks like an answer.
 *
 * Now that the server can embed text for queries it can also embed these, so the
 * index no longer depends on remembering to open Obsidian. Results are cached on
 * disk keyed by size and mtime, so a note is embedded once and re-embedded only
 * when it actually changes.
 *
 * This supplements Smart Connections rather than replacing it. The plugin remains
 * the primary index (it does block-level embeddings, which this does not); this
 * only fills the gap for whole notes it has not seen.
 */
export interface SupplementalIndex {
    vectors: Map<string, number[]>;
    /** Notes embedded during this run, so the caller can report the catch-up. */
    newlyEmbedded: number;
    /** Notes on disk that Smart Connections has never seen. */
    missingFromPlugin: number;
}
/**
 * Embed every note the plugin has not indexed. `knownPaths` is what Smart
 * Connections already covers, which we never duplicate.
 *
 * `maxNotes` bounds a first run on a vault that has drifted badly, so the first
 * query after a long gap does not hang. Anything beyond the cap is embedded on
 * the next call, and the count is reported rather than hidden.
 */
export declare function buildSupplementalIndex(vaultPath: string, knownPaths: Set<string>, maxNotes?: number): Promise<SupplementalIndex>;
//# sourceMappingURL=vault-indexer.d.ts.map