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
 * CHUNKING. This used to embed each note whole, which quietly capped what search
 * could see. `SAFE_CHARS` is 1200, and on a real vault the median note runs
 * several thousand characters, so a note vector represented the opening and
 * nothing else. Measured on Dan's 630-note vault: retrieving a note from a
 * passage in its own body scored recall@1 of 15% on note vectors against 57% on
 * per-section vectors. That gap is not a ranking subtlety, it is most of every
 * long note having no representation at all.
 *
 * So notes are split on markdown headings and each section is embedded
 * separately, which is the same thing Smart Connections does and the actual
 * reason its index is better. The plugin is now a cache of work we can do
 * ourselves rather than a prerequisite for finding anything.
 */
export interface SupplementalIndex {
    vectors: Map<string, number[]>;
    /** Per-section vectors by note path, mirroring the plugin's block index. */
    sections: Map<string, number[][]>;
    /** Notes embedded during this run, so the caller can report the catch-up. */
    newlyEmbedded: number;
    /** Notes on disk that Smart Connections has never seen. */
    missingFromPlugin: number;
}
export declare function listMarkdown(root: string, dir?: string, out?: string[]): string[];
export declare function splitIntoSections(relPath: string, text: string, maxChars?: number): string[];
export declare function buildSupplementalIndex(vaultPath: string, knownPaths: Set<string>, maxEmbeddings?: number): Promise<SupplementalIndex>;
//# sourceMappingURL=vault-indexer.d.ts.map