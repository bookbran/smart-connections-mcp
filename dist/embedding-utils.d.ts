/**
 * Embedding utilities for vector similarity calculations
 */
/**
 * Calculate cosine similarity between two vectors
 */
export declare function cosineSimilarity(vecA: number[], vecB: number[]): number;
/**
 * Find k nearest neighbors using cosine similarity
 */
export declare function findNearestNeighbors(queryVec: number[], vectors: Array<{
    id: string;
    vec: number[];
    metadata?: any;
}>, k: number, threshold?: number): Array<{
    id: string;
    similarity: number;
    metadata?: any;
}>;
/**
 * The best similarity any of the given vectors achieves against the corpus.
 *
 * Used to measure the NOISE CEILING: embed a few fixed gibberish anchors and
 * ask how well they score against this vault. Whatever they reach is what
 * unrelated text scores here, and a real result at or below it deserves a
 * warning rather than a confident list. Measured on the vault that motivated
 * this (bge-micro-v2): pure gibberish scored 0.62-0.64 while the search_notes
 * default threshold sat at 0.4 — the floor existed and filtered nothing,
 * because absolute cosine floors sit below this model's baseline for
 * unrelated text. The ceiling is measured per corpus, never assumed per
 * model, so a different embedding model calibrates itself.
 */
export declare function maxSimilarityAgainst(probeVecs: number[][], corpusVecs: Iterable<number[]>): number | null;
/**
 * Normalize a vector to unit length
 */
export declare function normalizeVector(vec: number[]): number[];
//# sourceMappingURL=embedding-utils.d.ts.map