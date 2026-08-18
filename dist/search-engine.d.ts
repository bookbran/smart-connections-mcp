/**
 * Semantic search engine for Smart Connections
 */
import type { SimilarNote, ConnectionGraph, NoteContent, SearchResponse, SearchHealthReport } from './types.js';
import type { SmartConnectionsLoader } from './smart-connections-loader.js';
export declare class SearchEngine {
    private loader;
    private embeddingModelKey;
    private supplementalPromise;
    constructor(loader: SmartConnectionsLoader);
    /**
     * Find similar notes to a given note path
     */
    getSimilarNotes(notePath: string, threshold?: number, limit?: number): SimilarNote[];
    /**
     * Get embedding neighbors for a given embedding vector
     */
    getEmbeddingNeighbors(embeddingVector: number[], k?: number, threshold?: number): SimilarNote[];
    /**
     * Build a connection graph starting from a note
     */
    getConnectionGraph(notePath: string, depth?: number, threshold?: number, maxPerLevel?: number): ConnectionGraph;
    /**
     * Search notes by semantic similarity to a text query.
     *
     * Embeds the query with the same model used for the stored note embeddings
     * (bge-micro-v2) and ranks notes by cosine similarity. If the embedding model
     * cannot be loaded (e.g. offline with no cached model), falls back to a
     * multi-term lexical search so the tool still returns useful results.
     *
     * Always returns an envelope naming which engine answered and how much of the
     * vault it could see. "0 results, semantic, 525 of 525 searched" and "0
     * results, keyword fallback, 433 of 525 searched" are different facts about
     * the world, and until now they were the same two characters: `[]`.
     */
    searchByQuery(queryText: string, limit?: number, threshold?: number): Promise<SearchResponse>;
    /**
     * Score every note by the best evidence available for it: its whole-note
     * vector, or its closest individual section, whichever matches the query more.
     *
     * Note vectors are truncated to the embedding model's window, so on a vault of
     * ordinary multi-thousand-character notes they represent the opening and
     * nothing after it. Sections are what make the rest reachable. Measured on
     * Dan's 630-note vault, retrieving a note from a passage of its own body:
     * recall@1 15% on note vectors, 57% on sections, and the hybrid matched
     * sections while keeping the note vector's small edge on short title-shaped
     * queries. Taking the max rather than averaging is deliberate: one strongly
     * relevant section is a reason to return a note, and averaging it against
     * unrelated sections in the same note would bury exactly the long, wide-ranging
     * notes that need this most.
     *
     * Sections come from Smart Connections where the plugin has run, and from our
     * own indexer where it has not, so the two paths produce the same ranking.
     */
    private denseScores;
    /**
     * Fuse dense and lexical rankings with Reciprocal Rank Fusion.
     *
     * Dense retrieval has a structural blind spot that no amount of better
     * embedding fixes: short literal tokens. An error code, a date, a person's
     * surname, a config flag, a commit SHA. Those carry almost no semantic signal,
     * so a vector model has nothing to grip, while a lexical scorer finds them
     * immediately. The 2026 retrieval literature is consistent that fusing the two
     * is the single largest post-baseline improvement available, ahead of
     * reranking and ahead of chunking strategy, because it closes a gap the other
     * two cannot reach.
     *
     * RRF fuses by RANK rather than score, which is what makes it usable here:
     * cosine similarity and a term-coverage score live on incompatible scales and
     * any attempt to normalise them is a tuning exercise that goes stale. Summing
     * 1/(k + rank) needs no normalisation and rewards notes both retrievers agree
     * on. k=60 is the value from the original paper and the field default; it
     * damps the top of each list so one retriever cannot dominate outright.
     *
     * The reported `similarity` stays the dense cosine, so existing thresholds and
     * expectations still mean what they meant. `matchedVia` says which retriever
     * actually found a result, because "this surfaced on a literal term match with
     * near-zero semantic similarity" is something a caller should be able to see
     * rather than infer from a confusing score.
     */
    private rankFused;
    /** Vector dataset from the notes Smart Connections has already embedded. */
    private pluginVectors;
    /**
     * Wrap results with the facts a caller needs to judge them.
     *
     * `supplemental` is null on the lexical path, where the on-disk catch-up index
     * was never built, so the vault total falls back to what the plugin knows and
     * `unsearchable` stays honest rather than guessing at zero.
     */
    private buildResponse;
    private buildCoverage;
    /**
     * The loud part. A caller that ignores everything else should still not be
     * able to read a degraded answer as a clean one.
     */
    private coverageWarning;
    /**
     * Positive control: ask for notes we know are there, and see if they come back.
     *
     * "Did we get results" is the wrong question, because a blind index answers it
     * the same way an empty topic does. The right question is "did we get the one
     * we buried on purpose." A canary is only useful because it stops singing.
     *
     * Probes are drawn from the live index rather than a planted starter note, so
     * this works on any vault, including one that has been running for a year.
     * `canaryPath` pins a specific note when the kit ships one.
     */
    checkSearchHealth(canaryPath?: string): Promise<SearchHealthReport>;
    /**
     * Query a note by its own title. If retrieval cannot find a note when handed
     * that note's title, it cannot find anything.
     */
    private pickProbeTargets;
    /**
     * Lexical fallback: multi-term keyword scoring.
     *
     * Unlike the previous implementation, this tokenizes the query into terms
     * (dropping stopwords) and scores by how many distinct query terms a note
     * contains (coverage) plus a small term-frequency bonus. This means
     * multi-word queries like "intake call guide" match notes that contain those
     * words anywhere, instead of requiring the exact phrase as a literal
     * substring. Scores are normalized to 0-1 so `threshold` is meaningful.
     */
    /**
     * Built once per server run and reused; the on-disk cache makes a restart cheap.
     */
    private getSupplementalIndex;
    searchByKeyword(queryText: string, limit?: number, threshold?: number): SimilarNote[];
    /**
     * Get note content with matched blocks highlighted
     */
    getNoteWithContext(notePath: string, includeBlocks?: string[]): NoteContent;
    /**
     * Get statistics about the knowledge base
     */
    getStats(): {
        totalNotes: number;
        totalBlocks: number;
        embeddingDimension: number;
        modelKey: string;
    };
}
//# sourceMappingURL=search-engine.d.ts.map