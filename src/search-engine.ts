/**
 * Semantic search engine for Smart Connections
 */

import type { SmartSource, SimilarNote, ConnectionNode, ConnectionGraph, NoteContent } from './types.js';
import { cosineSimilarity, findNearestNeighbors } from './embedding-utils.js';
import { embedText } from './embedder.js';
import { buildSupplementalIndex, type SupplementalIndex } from './vault-indexer.js';
import type { SmartConnectionsLoader } from './smart-connections-loader.js';

function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Common English stopwords dropped from lexical fallback queries.
const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'of', 'to', 'in', 'on', 'for', 'with',
  'is', 'are', 'was', 'were', 'be', 'been', 'it', 'this', 'that', 'these',
  'those', 'as', 'at', 'by', 'from', 'about', 'into', 'how', 'what', 'when',
  'who', 'which', 'i', 'you', 'we', 'they', 'do', 'does', 'my', 'our',
]);

export class SearchEngine {
  private loader: SmartConnectionsLoader;
  private embeddingModelKey: string;
  private supplementalPromise: Promise<SupplementalIndex> | null = null;

  constructor(loader: SmartConnectionsLoader) {
    this.loader = loader;
    this.embeddingModelKey = loader.getEmbeddingModelKey();
  }

  /**
   * Find similar notes to a given note path
   */
  getSimilarNotes(
    notePath: string,
    threshold: number = 0.5,
    limit: number = 10
  ): SimilarNote[] {
    const source = this.loader.getSource(notePath);

    if (!source) {
      throw new Error(`Note not found: ${notePath}`);
    }

    const embeddings = source.embeddings[this.embeddingModelKey];

    if (!embeddings || !embeddings.vec) {
      throw new Error(`No embeddings found for note: ${notePath}`);
    }

    // Build vector dataset from all sources
    const vectors = Array.from(this.loader.getSources().entries())
      .filter(([path]) => path !== notePath) // Exclude the query note itself
      .map(([path, src]) => {
        const emb = src.embeddings[this.embeddingModelKey];
        return {
          id: path,
          vec: emb?.vec || [],
          metadata: {
            blocks: Object.keys(src.blocks || {}),
            lastModified: src.last_import?.mtime || 0
          }
        };
      })
      .filter(item => item.vec.length > 0);

    // Find nearest neighbors
    const neighbors = findNearestNeighbors(
      embeddings.vec,
      vectors,
      limit,
      threshold
    );

    // Convert to SimilarNote format
    return neighbors.map(neighbor => ({
      path: neighbor.id,
      similarity: neighbor.similarity,
      blocks: neighbor.metadata.blocks
    }));
  }

  /**
   * Get embedding neighbors for a given embedding vector
   */
  getEmbeddingNeighbors(
    embeddingVector: number[],
    k: number = 10,
    threshold: number = 0.5
  ): SimilarNote[] {
    // Build vector dataset from all sources
    const vectors = Array.from(this.loader.getSources().entries())
      .map(([path, src]) => {
        const emb = src.embeddings[this.embeddingModelKey];
        return {
          id: path,
          vec: emb?.vec || [],
          metadata: {
            blocks: Object.keys(src.blocks || {}),
            lastModified: src.last_import?.mtime || 0
          }
        };
      })
      .filter(item => item.vec.length > 0);

    // Find nearest neighbors
    const neighbors = findNearestNeighbors(
      embeddingVector,
      vectors,
      k,
      threshold
    );

    // Convert to SimilarNote format
    return neighbors.map(neighbor => ({
      path: neighbor.id,
      similarity: neighbor.similarity,
      blocks: neighbor.metadata.blocks
    }));
  }

  /**
   * Build a connection graph starting from a note
   */
  getConnectionGraph(
    notePath: string,
    depth: number = 2,
    threshold: number = 0.6,
    maxPerLevel: number = 5
  ): ConnectionGraph {
    const visited = new Set<string>();
    const flatConnections: Array<{ path: string; depth: number; similarity: number }> = [];

    const buildGraph = (
      currentPath: string,
      currentDepth: number,
      parentSimilarity: number = 1.0
    ): void => {
      visited.add(currentPath);

      // Add to flat list (skip root at depth 0)
      if (currentDepth > 0) {
        flatConnections.push({
          path: currentPath,
          depth: currentDepth,
          similarity: parentSimilarity
        });
      }

      // Stop if we've reached max depth
      if (currentDepth >= depth) {
        return;
      }

      // Find similar notes
      try {
        const similar = this.getSimilarNotes(
          currentPath,
          threshold,
          maxPerLevel
        );

        // Recursively build connections
        for (const sim of similar) {
          // Skip already visited nodes to prevent cycles
          if (!visited.has(sim.path)) {
            buildGraph(
              sim.path,
              currentDepth + 1,
              sim.similarity
            );
          }
        }
      } catch (error) {
        console.error(`Error building graph for ${currentPath}:`, error);
      }
    };

    buildGraph(notePath, 0);

    return {
      root: notePath,
      connections: flatConnections
    };
  }

  /**
   * Search notes by semantic similarity to a text query.
   *
   * Embeds the query with the same model used for the stored note embeddings
   * (bge-micro-v2) and ranks notes by cosine similarity. If the embedding model
   * can't be loaded (e.g. offline with no cached model), falls back to a
   * multi-term lexical search so the tool still returns useful results.
   */
  async searchByQuery(
    queryText: string,
    limit: number = 10,
    threshold: number = 0.4
  ): Promise<SimilarNote[]> {
    try {
      const queryVec = await embedText(queryText, this.embeddingModelKey);
      if (queryVec.length > 0) {
        // Notes written since Obsidian last indexed are absent from the plugin's
        // data. Leaving them out means confidently returning the second-best
        // answer while the best one is invisible, so they are embedded here and
        // searched alongside. See `vault-indexer`.
        const supplemental = await this.getSupplementalIndex();
        if (supplemental.vectors.size === 0) {
          return this.getEmbeddingNeighbors(queryVec, limit, threshold);
        }
        const vectors = Array.from(this.loader.getSources().entries())
          .map(([path, src]) => ({
            id: path,
            vec: src.embeddings[this.embeddingModelKey]?.vec || [],
            metadata: { blocks: Object.keys(src.blocks || {}), lastModified: 0 },
          }))
          .filter((item) => item.vec.length > 0);
        for (const [path, vec] of supplemental.vectors) {
          vectors.push({ id: path, vec, metadata: { blocks: [], lastModified: 0 } });
        }
        return findNearestNeighbors(queryVec, vectors, limit, threshold).map((n) => ({
          path: n.id,
          similarity: n.similarity,
          blocks: n.metadata.blocks,
        }));
      }
    } catch (error) {
      console.error('Semantic search unavailable, falling back to lexical:', error);
    }

    return this.searchByKeyword(queryText, limit, threshold);
  }

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
  private async getSupplementalIndex() {
    if (!this.supplementalPromise) {
      this.supplementalPromise = buildSupplementalIndex(
        this.loader.getVaultPath(),
        new Set(this.loader.getSources().keys())
      ).catch(() => ({
        vectors: new Map<string, number[]>(),
        newlyEmbedded: 0,
        missingFromPlugin: 0,
      }));
    }
    return this.supplementalPromise;
  }

  searchByKeyword(
    queryText: string,
    limit: number = 10,
    threshold: number = 0.4
  ): SimilarNote[] {
    const terms = Array.from(
      new Set(
        queryText
          .toLowerCase()
          .split(/[^a-z0-9]+/)
          .filter((t) => t.length > 1 && !STOPWORDS.has(t))
      )
    );

    if (terms.length === 0) {
      return [];
    }

    const results: SimilarNote[] = [];

    for (const [path, source] of this.loader.getSources()) {
      try {
        // Include the path/title so filename matches count too.
        const haystack = (path + '\n' + this.loader.readNoteContent(path)).toLowerCase();

        let matchedTerms = 0;
        let totalMatches = 0;
        for (const term of terms) {
          const count = (haystack.match(new RegExp(escapeRegExp(term), 'g')) || []).length;
          if (count > 0) {
            matchedTerms++;
            totalMatches += count;
          }
        }

        if (matchedTerms === 0) continue;

        // Coverage (how many distinct query terms appear) dominates; term
        // frequency is a light tiebreaker.
        const coverage = matchedTerms / terms.length;
        const tfBonus = Math.min(totalMatches / (terms.length * 8), 1);
        const score = coverage * 0.8 + tfBonus * 0.2;

        if (score >= threshold) {
          results.push({
            path,
            similarity: score,
            blocks: Object.keys(source.blocks || {}),
          });
        }
      } catch (error) {
        continue;
      }
    }

    return results
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, limit);
  }

  /**
   * Get note content with matched blocks highlighted
   */
  getNoteWithContext(
    notePath: string,
    includeBlocks: string[] = []
  ): NoteContent {
    const content = this.loader.readNoteContent(notePath);
    const source = this.loader.getSource(notePath);
    const availableBlocks = source ? Object.keys(source.blocks || {}) : [];

    return {
      path: notePath,
      content,
      blocks: availableBlocks
    };
  }

  /**
   * Get statistics about the knowledge base
   */
  getStats(): {
    totalNotes: number;
    totalBlocks: number;
    embeddingDimension: number;
    modelKey: string;
  } {
    const sources = this.loader.getSources();
    let totalBlocks = 0;
    let embeddingDim = 0;

    for (const source of sources.values()) {
      totalBlocks += Object.keys(source.blocks || {}).length;

      if (embeddingDim === 0) {
        const emb = source.embeddings[this.embeddingModelKey];
        if (emb?.vec) {
          embeddingDim = emb.vec.length;
        }
      }
    }

    return {
      totalNotes: sources.size,
      totalBlocks,
      embeddingDimension: embeddingDim,
      modelKey: this.embeddingModelKey
    };
  }
}
