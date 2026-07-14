/**
 * Semantic search engine for Smart Connections
 */
import type { SimilarNote, ConnectionGraph, NoteContent } from './types.js';
import type { SmartConnectionsLoader } from './smart-connections-loader.js';
export declare class SearchEngine {
    private loader;
    private embeddingModelKey;
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
     * can't be loaded (e.g. offline with no cached model), falls back to a
     * multi-term lexical search so the tool still returns useful results.
     */
    searchByQuery(queryText: string, limit?: number, threshold?: number): Promise<SimilarNote[]>;
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