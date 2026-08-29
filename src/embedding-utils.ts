/**
 * Embedding utilities for vector similarity calculations
 */

/**
 * Calculate cosine similarity between two vectors
 */
export function cosineSimilarity(vecA: number[], vecB: number[]): number {
  if (vecA.length !== vecB.length) {
    throw new Error('Vectors must have the same length');
  }

  let dotProduct = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < vecA.length; i++) {
    dotProduct += vecA[i] * vecB[i];
    normA += vecA[i] * vecA[i];
    normB += vecB[i] * vecB[i];
  }

  const magnitude = Math.sqrt(normA) * Math.sqrt(normB);

  if (magnitude === 0) {
    return 0;
  }

  return dotProduct / magnitude;
}

/**
 * Find k nearest neighbors using cosine similarity
 */
export function findNearestNeighbors(
  queryVec: number[],
  vectors: Array<{ id: string; vec: number[]; metadata?: any }>,
  k: number,
  threshold: number = 0.0
): Array<{ id: string; similarity: number; metadata?: any }> {
  const similarities = vectors.map(item => ({
    id: item.id,
    similarity: cosineSimilarity(queryVec, item.vec),
    metadata: item.metadata
  }));

  // Filter by threshold and sort by similarity (descending)
  return similarities
    .filter(item => item.similarity >= threshold)
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, k);
}

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
export function maxSimilarityAgainst(
  probeVecs: number[][],
  corpusVecs: Iterable<number[]>
): number | null {
  let best: number | null = null;
  const vecs = Array.from(corpusVecs);
  if (probeVecs.length === 0 || vecs.length === 0) return null;
  for (const probe of probeVecs) {
    for (const vec of vecs) {
      if (probe.length !== vec.length) continue;
      const s = cosineSimilarity(probe, vec);
      if (best === null || s > best) best = s;
    }
  }
  return best;
}

/**
 * Normalize a vector to unit length
 */
export function normalizeVector(vec: number[]): number[] {
  const norm = Math.sqrt(vec.reduce((sum, val) => sum + val * val, 0));
  if (norm === 0) return vec;
  return vec.map(val => val / norm);
}
