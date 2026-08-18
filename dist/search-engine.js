/**
 * Semantic search engine for Smart Connections
 */
import { findNearestNeighbors } from './embedding-utils.js';
import { embedText } from './embedder.js';
import { buildSupplementalIndex } from './vault-indexer.js';
function escapeRegExp(str) {
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
    loader;
    embeddingModelKey;
    supplementalPromise = null;
    constructor(loader) {
        this.loader = loader;
        this.embeddingModelKey = loader.getEmbeddingModelKey();
    }
    /**
     * Find similar notes to a given note path
     */
    getSimilarNotes(notePath, threshold = 0.5, limit = 10) {
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
        const neighbors = findNearestNeighbors(embeddings.vec, vectors, limit, threshold);
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
    getEmbeddingNeighbors(embeddingVector, k = 10, threshold = 0.5) {
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
        const neighbors = findNearestNeighbors(embeddingVector, vectors, k, threshold);
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
    getConnectionGraph(notePath, depth = 2, threshold = 0.6, maxPerLevel = 5) {
        const visited = new Set();
        const flatConnections = [];
        const buildGraph = (currentPath, currentDepth, parentSimilarity = 1.0) => {
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
                const similar = this.getSimilarNotes(currentPath, threshold, maxPerLevel);
                // Recursively build connections
                for (const sim of similar) {
                    // Skip already visited nodes to prevent cycles
                    if (!visited.has(sim.path)) {
                        buildGraph(sim.path, currentDepth + 1, sim.similarity);
                    }
                }
            }
            catch (error) {
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
    async searchByQuery(queryText, limit = 10, threshold = 0.4) {
        try {
            const queryVec = await embedText(queryText, this.embeddingModelKey);
            if (queryVec.length > 0) {
                // Notes written since Obsidian last indexed are absent from the plugin's
                // data. Leaving them out means confidently returning the second-best
                // answer while the best one is invisible, so they are embedded here and
                // searched alongside. See `vault-indexer`.
                const supplemental = await this.getSupplementalIndex();
                const vectors = this.pluginVectors();
                for (const [path, vec] of supplemental.vectors) {
                    vectors.push({ id: path, vec, metadata: { blocks: [], lastModified: 0 } });
                }
                const results = findNearestNeighbors(queryVec, vectors, limit, threshold).map((n) => ({
                    path: n.id,
                    similarity: n.similarity,
                    blocks: n.metadata.blocks,
                }));
                return this.buildResponse('semantic', results, threshold, supplemental);
            }
        }
        catch (error) {
            console.error('Semantic search unavailable, falling back to lexical:', error);
        }
        const results = this.searchByKeyword(queryText, limit, threshold);
        return this.buildResponse('keyword', results, threshold, null);
    }
    /** Vector dataset from the notes Smart Connections has already embedded. */
    pluginVectors() {
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
    buildResponse(mode, results, threshold, supplemental) {
        const coverage = this.buildCoverage(mode, supplemental);
        const response = { mode, results, coverage, threshold };
        const warning = this.coverageWarning(mode, coverage, results.length);
        if (warning)
            response.warning = warning;
        return response;
    }
    buildCoverage(mode, supplemental) {
        const fromPlugin = mode === 'semantic' ? this.pluginVectors().length : this.loader.getSources().size;
        const supplementalCount = supplemental ? supplemental.vectors.size : 0;
        const searched = fromPlugin + supplementalCount;
        // Notes the plugin has never seen still exist on disk. Counting them keeps
        // `vaultTotal` the size of the real vault rather than the size of the index.
        const vaultTotal = this.loader.getSources().size + (supplemental?.missingFromPlugin ?? 0);
        return {
            searched,
            vaultTotal,
            fromPlugin,
            supplemental: supplementalCount,
            unsearchable: Math.max(0, vaultTotal - searched),
        };
    }
    /**
     * The loud part. A caller that ignores everything else should still not be
     * able to read a degraded answer as a clean one.
     */
    coverageWarning(mode, coverage, resultCount) {
        const parts = [];
        if (mode === 'keyword') {
            parts.push('SEARCH IS DEGRADED: the embedding model did not load, so this answer came from ' +
                'literal keyword matching and will miss anything phrased differently. ' +
                'Do not report an empty or thin result as "the vault has nothing on this."');
        }
        if (coverage.unsearchable > 0) {
            parts.push(`${coverage.unsearchable} of ${coverage.vaultTotal} notes could not be searched this run.`);
        }
        if (resultCount === 0 && parts.length === 0) {
            parts.push(`No matches above threshold. This was a full ${mode} search of ` +
                `${coverage.searched} of ${coverage.vaultTotal} notes, so the vault genuinely ` +
                'appears to have nothing closer. Lower the threshold to widen recall.');
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
    async checkSearchHealth(canaryPath) {
        const probeTargets = this.pickProbeTargets(canaryPath);
        const probes = [];
        let mode = 'semantic';
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
        // One miss is a ranking accident; a clean sweep of misses is blindness.
        const alive = probes.length > 0 && probesPassed > 0 && mode === 'semantic';
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
    pickProbeTargets(canaryPath) {
        const paths = Array.from(this.loader.getSources().keys());
        if (paths.length === 0)
            return [];
        const chosen = [];
        if (canaryPath && paths.includes(canaryPath))
            chosen.push(canaryPath);
        // Deterministic spread across the vault, so repeated runs are comparable and
        // one unlucky note cannot flip the verdict on its own.
        const sorted = [...paths].sort();
        for (const fraction of [0.1, 0.5, 0.9]) {
            const candidate = sorted[Math.floor(sorted.length * fraction)];
            if (candidate && !chosen.includes(candidate))
                chosen.push(candidate);
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
    async getSupplementalIndex() {
        if (!this.supplementalPromise) {
            this.supplementalPromise = buildSupplementalIndex(this.loader.getVaultPath(), new Set(this.loader.getSources().keys())).catch(() => ({
                vectors: new Map(),
                newlyEmbedded: 0,
                missingFromPlugin: 0,
            }));
        }
        return this.supplementalPromise;
    }
    searchByKeyword(queryText, limit = 10, threshold = 0.4) {
        const terms = Array.from(new Set(queryText
            .toLowerCase()
            .split(/[^a-z0-9]+/)
            .filter((t) => t.length > 1 && !STOPWORDS.has(t))));
        if (terms.length === 0) {
            return [];
        }
        const results = [];
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
                if (matchedTerms === 0)
                    continue;
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
            }
            catch (error) {
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
    getNoteWithContext(notePath, includeBlocks = []) {
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
    getStats() {
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
function titleFromPath(notePath) {
    const base = notePath.split(/[\\/]/).pop() || notePath;
    return base.replace(/\.md$/i, '').replace(/[-_]+/g, ' ').trim();
}
function buildVerdict(alive, mode, coverage, passed, run) {
    if (run === 0) {
        return 'SEARCH IS BLIND: no notes are indexed at all, so every query will return nothing.';
    }
    if (mode === 'keyword') {
        return ('SEARCH IS DEGRADED: the embedding model did not load and this server is ' +
            'answering with literal keyword matching. Empty results from it mean nothing. ' +
            'Fix the model before trusting any "the vault has nothing on this" answer.');
    }
    if (!alive) {
        return (`SEARCH IS BLIND: ${run} notes were asked for by their own titles and ${run - passed} ` +
            'did not come back. An empty result from this server cannot currently be trusted.');
    }
    const gap = coverage.unsearchable > 0
        ? ` ${coverage.unsearchable} of ${coverage.vaultTotal} notes are not searchable yet.`
        : '';
    return (`Search is alive: ${passed} of ${run} planted queries came back, semantic mode, ` +
        `${coverage.searched} of ${coverage.vaultTotal} notes searchable.${gap}`);
}
//# sourceMappingURL=search-engine.js.map