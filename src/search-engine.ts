/**
 * Semantic search engine for Smart Connections
 */

import type {
  SmartSource, SimilarNote, ConnectionNode, ConnectionGraph, NoteContent,
  SearchMode, SearchCoverage, SearchResponse, SearchHealthProbe, SearchHealthReport,
} from './types.js';
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
   * cannot be loaded (e.g. offline with no cached model), falls back to a
   * multi-term lexical search so the tool still returns useful results.
   *
   * Always returns an envelope naming which engine answered and how much of the
   * vault it could see. "0 results, semantic, 525 of 525 searched" and "0
   * results, keyword fallback, 433 of 525 searched" are different facts about
   * the world, and until now they were the same two characters: `[]`.
   */
  async searchByQuery(
    queryText: string,
    limit: number = 10,
    threshold: number = 0.4
  ): Promise<SearchResponse> {
    try {
      const queryVec = await embedText(queryText, this.embeddingModelKey);
      if (queryVec.length > 0) {
        // Notes written since Obsidian last indexed are absent from the plugin's
        // data. Leaving them out means confidently returning the second-best
        // answer while the best one is invisible, so they are embedded here and
        // searched alongside. See `vault-indexer`.
        const supplemental = await this.getSupplementalIndex();
        const results = this.rankHybrid(queryVec, supplemental, limit, threshold);
        return this.buildResponse('semantic', results, threshold, supplemental);
      }
    } catch (error) {
      console.error('Semantic search unavailable, falling back to lexical:', error);
    }

    const results = this.searchByKeyword(queryText, limit, threshold);
    return this.buildResponse('keyword', results, threshold, null);
  }

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
  private rankHybrid(
    queryVec: number[],
    supplemental: SupplementalIndex,
    limit: number,
    threshold: number
  ): SimilarNote[] {
    const best = new Map<string, { score: number; blocks: string[] }>();

    const offer = (path: string, score: number, blocks: string[]) => {
      const prev = best.get(path);
      if (!prev || score > prev.score) best.set(path, { score, blocks });
      else if (prev && blocks.length && !prev.blocks.length) prev.blocks = blocks;
    };

    for (const item of this.pluginVectors()) {
      offer(item.id, cosineSimilarity(queryVec, item.vec), item.metadata.blocks);
    }
    for (const [path, vec] of supplemental.vectors) {
      offer(path, cosineSimilarity(queryVec, vec), []);
    }

    const pluginBlocks = this.loader.getBlockVectors();
    for (const [path, blocks] of pluginBlocks) {
      const headings: string[] = [];
      let top = -1;
      for (const b of blocks) {
        const score = cosineSimilarity(queryVec, b.vec);
        if (score > top) {
          top = score;
          headings.length = 0;
          if (b.heading) headings.push(b.heading);
        }
      }
      if (top > -1) offer(path, top, headings);
    }
    for (const [path, vecs] of supplemental.sections) {
      let top = -1;
      for (const vec of vecs) {
        const score = cosineSimilarity(queryVec, vec);
        if (score > top) top = score;
      }
      if (top > -1) offer(path, top, []);
    }

    return Array.from(best.entries())
      .filter(([, v]) => v.score >= threshold)
      .sort((a, b) => b[1].score - a[1].score)
      .slice(0, limit)
      .map(([path, v]) => ({ path, similarity: v.score, blocks: v.blocks }));
  }

  /** Vector dataset from the notes Smart Connections has already embedded. */
  private pluginVectors() {
    return Array.from(this.loader.getSources().entries())
      .map(([path, src]) => ({
        id: path,
        vec: src.embeddings[this.embeddingModelKey]?.vec || [],
        metadata: {
          blocks: Object.keys(src.blocks || {}),
          lastModified: src.last_import?.mtime || 0,
        },
      }))
      .filter((item) => item.vec.length > 0);
  }

  /**
   * Wrap results with the facts a caller needs to judge them.
   *
   * `supplemental` is null on the lexical path, where the on-disk catch-up index
   * was never built, so the vault total falls back to what the plugin knows and
   * `unsearchable` stays honest rather than guessing at zero.
   */
  private buildResponse(
    mode: SearchMode,
    results: SimilarNote[],
    threshold: number,
    supplemental: SupplementalIndex | null
  ): SearchResponse {
    const coverage = this.buildCoverage(mode, supplemental);
    const response: SearchResponse = { mode, results, coverage, threshold };
    const warning = this.coverageWarning(mode, coverage, results.length);
    if (warning) response.warning = warning;
    return response;
  }

  private buildCoverage(
    mode: SearchMode,
    supplemental: SupplementalIndex | null
  ): SearchCoverage {
    const fromPlugin =
      mode === 'semantic' ? this.pluginVectors().length : this.loader.getSources().size;
    const supplementalCount = supplemental ? supplemental.vectors.size : 0;
    // Sections are the reason a long note is findable at all, so report them
    // rather than letting "630 of 630 searched" hide a vault with no chunking.
    let sectionCount = 0;
    for (const list of this.loader.getBlockVectors().values()) sectionCount += list.length;
    if (supplemental) {
      for (const list of supplemental.sections.values()) sectionCount += list.length;
    }
    const searched = fromPlugin + supplementalCount;
    // Notes the plugin has never seen still exist on disk. Counting them keeps
    // `vaultTotal` the size of the real vault rather than the size of the index.
    const vaultTotal = this.loader.getSources().size + (supplemental?.missingFromPlugin ?? 0);
    return {
      searched,
      vaultTotal,
      fromPlugin,
      supplemental: supplementalCount,
      sections: sectionCount,
      unsearchable: Math.max(0, vaultTotal - searched),
    };
  }

  /**
   * The loud part. A caller that ignores everything else should still not be
   * able to read a degraded answer as a clean one.
   */
  private coverageWarning(
    mode: SearchMode,
    coverage: SearchCoverage,
    resultCount: number
  ): string | undefined {
    const parts: string[] = [];
    if (mode === 'keyword') {
      parts.push(
        'SEARCH IS DEGRADED: the embedding model did not load, so this answer came from ' +
          'literal keyword matching and will miss anything phrased differently. ' +
          'Do not report an empty or thin result as "the vault has nothing on this."'
      );
    }
    if (coverage.unsearchable > 0) {
      parts.push(
        `${coverage.unsearchable} of ${coverage.vaultTotal} notes could not be searched this run.`
      );
    }
    if (resultCount === 0 && parts.length === 0) {
      parts.push(
        `No matches above threshold. This was a full ${mode} search of ` +
          `${coverage.searched} of ${coverage.vaultTotal} notes, so the vault genuinely ` +
          'appears to have nothing closer. Lower the threshold to widen recall.'
      );
    }
    return parts.length > 0 ? parts.join(' ') : undefined;
  }

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
  async checkSearchHealth(canaryPath?: string): Promise<SearchHealthReport> {
    const supplementalForProbes = await this.getSupplementalIndex();
    const probeTargets = this.pickProbeTargets(supplementalForProbes, canaryPath);
    const probes: SearchHealthProbe[] = [];
    let mode: SearchMode = 'semantic';
    let coverage = this.buildCoverage('semantic', await this.getSupplementalIndex());

    for (const target of probeTargets) {
      // Threshold deliberately low: this asks whether the note is reachable at
      // all, not whether it would rank well for a member's real question.
      const response = await this.searchByQuery(target.query, 10, 0.2);
      mode = response.mode;
      coverage = response.coverage;
      const rank = response.results.findIndex((r) => r.path === target.path);
      probes.push({
        query: target.query,
        expectedPath: target.path,
        found: rank >= 0,
        rank: rank >= 0 ? rank + 1 : null,
        similarity: rank >= 0 ? response.results[rank].similarity : null,
      });
    }

    const probesPassed = probes.filter((p) => p.found).length;
    // Three conditions, because there are three ways to be untrustworthy and
    // only one of them is "retrieval is completely dead".
    //   - a clean sweep of probe misses is blindness (one miss is a ranking
    //     accident, so require a majority rather than a single hit)
    //   - keyword mode means the embedding model never loaded
    //   - and a large unsearchable slice means an empty result proves nothing,
    //     even though the notes it CAN see come back fine. That last case is the
    //     one that nearly slipped through: with most of the vault missing, the
    //     probes that happened to land on indexed notes still passed.
    const majority = Math.ceil(probes.length / 2);
    const coverageGap =
      coverage.vaultTotal > 0 ? coverage.unsearchable / coverage.vaultTotal : 0;
    const alive =
      probes.length > 0 &&
      probesPassed >= majority &&
      mode === 'semantic' &&
      coverageGap <= 0.1;

    return {
      alive,
      mode,
      coverage,
      modelKey: this.embeddingModelKey,
      probes,
      probesPassed,
      probesRun: probes.length,
      verdict: buildVerdict(alive, mode, coverage, probesPassed, probes.length),
    };
  }

  /**
   * Query a note by its own title. If retrieval cannot find a note when handed
   * that note's title, it cannot find anything.
   */
  private pickProbeTargets(
    supplemental: SupplementalIndex,
    canaryPath?: string
  ): Array<{ path: string; query: string }> {
    // Every note the engine can actually rank, not only the ones Smart
    // Connections knows about. Sampling the plugin alone made the canary report
    // "no notes are indexed" on a working plugin-free vault, which is a false
    // alarm, and a check that cries wolf gets ignored exactly like one that
    // stays silent when it should not.
    const paths = Array.from(
      new Set([...this.loader.getSources().keys(), ...supplemental.vectors.keys()])
    );
    if (paths.length === 0) return [];

    const chosen: string[] = [];
    if (canaryPath && paths.includes(canaryPath)) chosen.push(canaryPath);

    // Deterministic spread across the vault, so repeated runs are comparable and
    // one unlucky note cannot flip the verdict on its own.
    const sorted = [...paths].sort();
    for (const fraction of [0.1, 0.5, 0.9]) {
      const candidate = sorted[Math.floor(sorted.length * fraction)];
      if (candidate && !chosen.includes(candidate)) chosen.push(candidate);
    }

    return chosen.map((path) => ({ path, query: titleFromPath(path) }));
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
        sections: new Map<string, number[][]>(),
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


/** Filename without directories or extension, hyphens and underscores as spaces. */
function titleFromPath(notePath: string): string {
  const base = notePath.split(/[\\/]/).pop() || notePath;
  return base.replace(/\.md$/i, '').replace(/[-_]+/g, ' ').trim();
}

function buildVerdict(
  alive: boolean,
  mode: SearchMode,
  coverage: SearchCoverage,
  passed: number,
  run: number
): string {
  if (run === 0) {
    return 'SEARCH IS BLIND: no notes are indexed at all, so every query will return nothing.';
  }
  if (mode === 'keyword') {
    return (
      'SEARCH IS DEGRADED: the embedding model did not load and this server is ' +
      'answering with literal keyword matching. Empty results from it mean nothing. ' +
      'Fix the model before trusting any "the vault has nothing on this" answer.'
    );
  }
  if (!alive) {
    if (coverage.unsearchable > 0 && passed > 0) {
      return (
        `SEARCH IS PARTLY BLIND: only ${coverage.searched} of ${coverage.vaultTotal} notes ` +
        'can be searched, so the notes it does find are real but an empty result proves ' +
        'nothing. Do not report "the vault has nothing on this" until the index is complete.'
      );
    }
    return (
      `SEARCH IS BLIND: ${run} notes were asked for by their own titles and ${run - passed} ` +
      'did not come back. An empty result from this server cannot currently be trusted.'
    );
  }
  const gap =
    coverage.unsearchable > 0
      ? ` ${coverage.unsearchable} of ${coverage.vaultTotal} notes are not searchable yet.`
      : '';
  return (
    `Search is alive: ${passed} of ${run} planted queries came back, semantic mode, ` +
    `${coverage.searched} of ${coverage.vaultTotal} notes searchable.${gap}`
  );
}
