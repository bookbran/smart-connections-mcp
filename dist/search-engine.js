/**
 * Retrieval, and the facts a caller needs to judge it.
 *
 * Everything semantic in this file ranks against `CurrentCorpus` and nothing
 * else. That is the whole architectural point: `search_notes` returning current
 * results while `get_similar_notes` still answered from the plugin's old
 * snapshot would be the same bug with a smaller blast radius.
 */
import { cosineSimilarity, findNearestNeighbors } from './embedding-utils.js';
import { embedText } from './embedder.js';
import { CorpusProvider } from './current-corpus.js';
import { readCanonicalText, corpusIsClean } from './corpus-state.js';
import { canonicalPath } from './canonical-path.js';
import { DEFAULT_EMBED_BUDGET } from './vault-indexer.js';
function escapeRegExp(str) {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
// Common English stopwords dropped from lexical queries.
const STOPWORDS = new Set([
    'the', 'a', 'an', 'and', 'or', 'but', 'of', 'to', 'in', 'on', 'for', 'with',
    'is', 'are', 'was', 'were', 'be', 'been', 'it', 'this', 'that', 'these',
    'those', 'as', 'at', 'by', 'from', 'about', 'into', 'how', 'what', 'when',
    'who', 'which', 'i', 'you', 'we', 'they', 'do', 'does', 'my', 'our',
]);
/**
 * How many embed calls one interactive query may spend repairing the backlog
 * (tracker 7.1).
 *
 * The 3,000-call total stays; this is the much smaller slice an interactive
 * query is allowed to take from it. Spending "whatever budget is left" before
 * returning a query is exactly the multi-minute first query the total cap exists
 * to prevent, and on a fresh 700-note vault it would mean the member's first
 * question sits there for minutes while lexical search was ready immediately.
 */
export const DEFAULT_INTERACTIVE_EMBED_BUDGET = 40;
function envInt(name, fallback) {
    const raw = process.env[name];
    if (!raw)
        return fallback;
    const n = Number.parseInt(raw, 10);
    return Number.isFinite(n) && n >= 0 ? n : fallback;
}
export class SearchEngine {
    loader;
    corpus;
    embeddingModelKey;
    /**
     * Probe results, cached for the process.
     *
     * Probes test MACHINERY: can retrieval return a note it is holding a vector
     * for. Machinery does not change between queries, and re-embedding three
     * title queries on every search would be a real cost for no new information.
     * `check_search_health` always re-runs them, so the explicit check is never
     * answered from a cache.
     */
    probeCache = null;
    constructor(loader) {
        this.loader = loader;
        this.embeddingModelKey = loader.getEmbeddingModelKey();
        this.corpus = new CorpusProvider(loader, loader.getVaultPath());
    }
    // -- retrieval ------------------------------------------------------------
    /**
     * Semantic search over the vault.
     *
     * Interactive shape, from tracker 7.1: the lexical corpus is the whole vault
     * and answers immediately, a SMALL bounded number of pending notes get
     * repaired, and the query returns. It never drains the general backlog
     * synchronously.
     */
    async searchByQuery(queryText, limit = 10, threshold = 0.4) {
        const interactiveBudget = envInt('SMART_INDEX_INTERACTIVE_EMBED_BUDGET', DEFAULT_INTERACTIVE_EMBED_BUDGET);
        // Reconcile first, with no embedding, so the priority order below is
        // computed from a current picture rather than from directory order.
        const snapshot = await this.corpus.snapshot();
        const order = this.repairOrder(snapshot, queryText);
        let corpus;
        try {
            corpus = await this.corpus.get({ maxEmbeddings: interactiveBudget, order });
        }
        catch (error) {
            console.error('Corpus unavailable:', error);
            corpus = await this.corpus.get({ skipIndexing: true });
        }
        try {
            const queryVec = await embedText(queryText, this.embeddingModelKey);
            if (queryVec.length > 0) {
                const results = this.rankFused(queryVec, queryText, corpus, limit, threshold);
                return this.buildResponse('semantic', results, threshold, corpus);
            }
        }
        catch (error) {
            console.error('Semantic search unavailable, falling back to lexical:', error);
        }
        const results = this.searchByKeyword(queryText, corpus, limit, threshold);
        return this.buildResponse('keyword', results, threshold, corpus);
    }
    /**
     * Which pending notes to repair first (tracker 7.2).
     *
     * Directory order means a note edited today waits behind hundreds of unrelated
     * ones, which is the worst possible ordering: the note a member is asking
     * about is usually the note they just wrote. Query relevance leads, recency
     * breaks ties.
     *
     * The lexical scan that produces this is free, because reconciliation already
     * holds the canonical text.
     */
    repairOrder(state, queryText) {
        const pending = Array.from(state.semanticPending);
        if (pending.length === 0)
            return pending;
        const terms = tokenize(queryText);
        const scored = pending.map((path) => {
            let relevance = 0;
            if (terms.length) {
                const text = state.text.get(path);
                const haystack = ((text ?? '') + '\n' + path).toLowerCase();
                for (const term of terms)
                    if (haystack.includes(term))
                        relevance++;
            }
            return { path, relevance, mtime: state.onDisk.get(path)?.mtimeMs ?? 0 };
        });
        scored.sort((a, b) => b.relevance - a.relevance || b.mtime - a.mtime);
        return scored.map((s) => s.path);
    }
    /**
     * Score every note by the best evidence available for it: its whole-note
     * vector, or its closest individual section, whichever matches the query more.
     *
     * Taking the max rather than averaging is deliberate: one strongly relevant
     * section is a reason to return a note, and averaging it against unrelated
     * sections in the same note would bury exactly the long, wide-ranging notes
     * that need this most.
     *
     * Every vector reaching this function has already been vouched for. There is
     * no freshness check here and there must never be one, or there would be two
     * implementations of freshness disagreeing about a set.
     */
    denseScores(queryVec, corpus) {
        const best = new Map();
        const offer = (path, score, blocks) => {
            const prev = best.get(path);
            if (!prev || score > prev.score)
                best.set(path, { score, blocks });
            else if (blocks.length && !prev.blocks.length)
                prev.blocks = blocks;
        };
        for (const [path, vec] of corpus.noteVectors) {
            offer(path, cosineSimilarity(queryVec, vec), corpus.blockHeadings.get(path) ?? []);
        }
        for (const [path, blocks] of corpus.sectionVectors) {
            const headings = [];
            let top = -1;
            for (const b of blocks) {
                const score = cosineSimilarity(queryVec, b.vec);
                if (score > top) {
                    top = score;
                    headings.length = 0;
                    if (b.heading)
                        headings.push(b.heading);
                }
            }
            if (top > -1)
                offer(path, top, headings);
        }
        return best;
    }
    /**
     * Fuse dense and lexical rankings with Reciprocal Rank Fusion.
     *
     * Dense retrieval has a structural blind spot no better embedding fixes: short
     * literal tokens. An error code, a date, a surname, a config flag, a commit
     * SHA. A vector model has nothing to grip; a lexical scorer finds them
     * immediately. Fusing the two is the single largest post-baseline improvement
     * available, ahead of reranking and ahead of chunking strategy.
     *
     * RRF fuses by RANK rather than score, which is what makes it usable: cosine
     * similarity and a term-coverage score live on incompatible scales and any
     * attempt to normalise them is a tuning exercise that goes stale. k=60 is the
     * value from the original paper.
     *
     * Dropping stale vectors matters MOST here, and it is not obvious why. A stale
     * note still earns a dense rank, just a bad one. Because RRF sums contributions
     * from both lists, a note appearing in both at mediocre ranks beats a note
     * appearing only in the lexical list at rank 6. So a stale vector actively
     * SUPPRESSED the lexical rescue for its own note. Removing it does not just
     * stop a wrong answer, it restores a fallback path.
     */
    rankFused(queryVec, queryText, corpus, limit, threshold) {
        const K = 60;
        const dense = this.denseScores(queryVec, corpus);
        const denseRanked = Array.from(dense.entries()).sort((a, b) => b[1].score - a[1].score);
        // Threshold 0 and a deep cut: fusion needs ranks, and a lexical hit the dense
        // side scores poorly is exactly the case this exists to rescue.
        const lexical = this.searchByKeyword(queryText, corpus, 200, 0);
        const rrf = new Map();
        const seenLexical = new Set();
        denseRanked.forEach(([path], i) => {
            rrf.set(path, (rrf.get(path) ?? 0) + 1 / (K + i + 1));
        });
        lexical.forEach((r, i) => {
            rrf.set(r.path, (rrf.get(r.path) ?? 0) + 1 / (K + i + 1));
            seenLexical.add(r.path);
        });
        // A note earns a place either by clearing the semantic threshold or by
        // ranking near the top lexically. Without the second clause the threshold
        // would filter out precisely the literal-token rescues fusion is for.
        const lexicalRescue = new Set(lexical.slice(0, 20).map((r) => r.path));
        return Array.from(rrf.entries())
            .filter(([path]) => (dense.get(path)?.score ?? 0) >= threshold || lexicalRescue.has(path))
            .sort((a, b) => b[1] - a[1])
            .slice(0, limit)
            .map(([path]) => {
            const d = dense.get(path);
            const inLex = seenLexical.has(path);
            const semantic = (d?.score ?? 0) >= threshold;
            return {
                path,
                similarity: d?.score ?? 0,
                blocks: d?.blocks ?? corpus.blockHeadings.get(path) ?? [],
                matchedVia: semantic && inLex ? 'both' : inLex && !semantic ? 'lexical' : 'semantic',
            };
        });
    }
    /**
     * Literal term matching over EVERY readable note in the vault (tracker 3.1).
     *
     * It used to iterate `loader.getSources()`, so a note Smart Connections had
     * never seen was invisible to the keyword fallback despite sitting on disk.
     * That made an indexing backlog catastrophic rather than merely slow: during
     * the window before a note is embedded, it could not be found by ANY path.
     *
     * Now the lexical corpus is the whole vault and the semantic corpus is
     * whatever has a verified-current vector. That difference is exactly what
     * makes a backlog survivable: a note written thirty seconds ago is findable by
     * its own words immediately, and becomes findable by meaning once it converges.
     */
    searchByKeyword(queryText, corpus, limit = 10, threshold = 0.4) {
        const terms = tokenize(queryText);
        if (terms.length === 0)
            return [];
        const results = [];
        const matchers = terms.map((t) => new RegExp(escapeRegExp(t), 'g'));
        for (const path of corpus.state.onDisk.keys()) {
            const text = readCanonicalText(corpus.state, path);
            if (text === null)
                continue;
            const haystack = (path + '\n' + text).toLowerCase();
            let matchedTerms = 0;
            let totalMatches = 0;
            for (const re of matchers) {
                re.lastIndex = 0;
                const count = (haystack.match(re) || []).length;
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
            if (score < threshold)
                continue;
            results.push({
                path,
                similarity: score,
                blocks: corpus.blockHeadings.get(path) ?? [],
                matchedVia: 'lexical',
            });
        }
        return results.sort((a, b) => b.similarity - a.similarity).slice(0, limit);
    }
    /**
     * Notes similar to a given note (tracker 5.1, 5.2).
     *
     * Two separate things had to change. The comparison SET now comes from the
     * current corpus. And so does the QUERY NOTE's own vector, which is the easy
     * one to miss because it is fetched by a different call path: a note stale in
     * the plugin but freshly embedded here must be compared using OUR vector, not
     * the plugin's old one. Answering "what is this note like" from a vector built
     * out of text the member deleted in June is the same bug in a different tool.
     *
     * Async now, because the corpus is reconciled per operation. Worth it.
     */
    async getSimilarNotes(notePath, threshold = 0.5, limit = 10) {
        const corpus = await this.corpus.get({ skipIndexing: true });
        const path = corpus.state.resolvePath(notePath) ?? canonicalPath(notePath);
        if (!corpus.state.onDisk.has(path)) {
            throw new Error(`Note not found: ${notePath}`);
        }
        const queryVec = corpus.noteVectors.get(path);
        if (!queryVec) {
            const pending = corpus.state.semanticPending.has(path);
            throw new Error(pending
                ? `No verified-current embedding for ${notePath} yet. It exists on disk and is ` +
                    'queued for embedding; run refresh_search_index or search for it once to repair it. ' +
                    'Answering from a stale vector would describe a version of this note that no longer exists.'
                : `No embeddings found for note: ${notePath}`);
        }
        const vectors = Array.from(corpus.noteVectors.entries())
            .filter(([p]) => p !== path)
            .map(([p, vec]) => ({
            id: p,
            vec,
            metadata: { blocks: corpus.blockHeadings.get(p) ?? [] },
        }));
        return findNearestNeighbors(queryVec, vectors, limit, threshold).map((n) => ({
            path: n.id,
            similarity: n.similarity,
            blocks: n.metadata?.blocks ?? [],
        }));
    }
    /** Nearest neighbours for a caller-supplied vector (tracker 5.3). */
    async getEmbeddingNeighbors(embeddingVector, k = 10, threshold = 0.5) {
        const corpus = await this.corpus.get({ skipIndexing: true });
        const vectors = Array.from(corpus.noteVectors.entries()).map(([p, vec]) => ({
            id: p,
            vec,
            metadata: { blocks: corpus.blockHeadings.get(p) ?? [] },
        }));
        return findNearestNeighbors(embeddingVector, vectors, k, threshold).map((n) => ({
            path: n.id,
            similarity: n.similarity,
            blocks: n.metadata?.blocks ?? [],
        }));
    }
    /**
     * A multi-level connection graph (tracker 5.3).
     *
     * Inherits the fix through `getSimilarNotes`, which is the point of having one
     * corpus rather than a filter per call site. The test proves it rather than
     * assuming it.
     */
    async getConnectionGraph(notePath, depth = 2, threshold = 0.6, maxPerLevel = 5) {
        const visited = new Set();
        const flat = [];
        const build = async (current, currentDepth, similarity) => {
            visited.add(current);
            if (currentDepth > 0)
                flat.push({ path: current, depth: currentDepth, similarity });
            if (currentDepth >= depth)
                return;
            try {
                const similar = await this.getSimilarNotes(current, threshold, maxPerLevel);
                for (const sim of similar) {
                    if (visited.has(sim.path))
                        continue;
                    await build(sim.path, currentDepth + 1, sim.similarity);
                }
            }
            catch (error) {
                // A node with no current vector simply does not expand. It is not an
                // error for the graph as a whole, and it is honest: we cannot say what a
                // note is like until we have embedded what it currently says.
                console.error(`Graph node ${current} did not expand:`, error);
            }
        };
        const root = (await this.corpus.snapshot()).resolvePath(notePath) ?? canonicalPath(notePath);
        await build(root, 0, 1.0);
        return { root, connections: flat };
    }
    // -- content and stats ----------------------------------------------------
    /**
     * A note's text, plus the headings that can be trusted for it (tracker 5.5).
     *
     * Heading lists come from the plugin's block map, which is a set of
     * heading-to-line-range pairs recorded when the file was imported. Once the
     * file changes those coordinates are exactly as suspect as the vectors built
     * from them, so a stale source contributes nothing and headings are derived
     * from the current markdown instead. Handing back June's section names for a
     * file rewritten in August is a small lie that reads as a fact.
     */
    async getNoteWithContext(notePath) {
        const corpus = await this.corpus.get({ skipIndexing: true });
        const path = corpus.state.resolvePath(notePath) ?? canonicalPath(notePath);
        const content = this.loader.readNoteContent(corpus.state.onDisk.get(path)?.diskPath ?? path);
        const blocks = corpus.blockHeadings.get(path) ?? headingsFromMarkdown(content);
        return { path, content, blocks };
    }
    /**
     * Vault-world numbers, not plugin-world (tracker 5.4).
     *
     * `totalNotes` used to be `loader.getSources().size`, the size of the INDEX.
     * On this vault that reported 525 for a 702-note vault and called it the total.
     */
    async getStats() {
        const corpus = await this.corpus.get({ skipIndexing: true });
        let sections = 0;
        for (const list of corpus.sectionVectors.values())
            sections += list.length;
        const firstVec = corpus.noteVectors.values().next();
        return {
            vaultNotes: corpus.state.onDisk.size,
            pluginSources: this.loader.getSourceCount(),
            pluginFresh: corpus.state.pluginFresh.size,
            supplemental: corpus.state.supplementalFresh.size,
            semanticSearchable: corpus.semanticSearchable.size,
            semanticPending: corpus.state.semanticPending.size,
            totalSections: sections,
            embeddingDimension: firstVec.done ? 0 : firstVec.value.length,
            modelKey: this.embeddingModelKey,
            corpusGeneration: corpus.state.generation,
            verifiedAt: corpus.state.verifiedAt,
        };
    }
    // -- bulk repair ----------------------------------------------------------
    /**
     * Work the backlog deliberately, rather than trickling it through queries
     * (tracker 7.3).
     *
     * Resumable and idempotent, both by construction rather than by bookkeeping:
     * the pending set is recomputed from disk on every call, so an interruption,
     * a reboot, a failed embedding call and a second invocation all reduce to the
     * same thing. Whatever is still pending gets worked; whatever is current is
     * skipped without an embed call.
     *
     * Phase 10 depends on this being real, because a migrated vault arrives with
     * hundreds of notes at once and a 3,000-call budget.
     */
    async refreshSearchIndex(budget) {
        const max = budget ?? envInt('SMART_INDEX_EMBED_BUDGET', DEFAULT_EMBED_BUDGET);
        const corpus = await this.corpus.get({ maxEmbeddings: max });
        const s = corpus.supplemental;
        const coverage = this.buildCoverage('semantic', corpus);
        const summary = coverage.coverageComplete
            ? `Search is fully caught up: all ${coverage.eligible} eligible notes have a ` +
                'verified-current vector.'
            : `${s.newlyEmbedded} notes embedded, ${coverage.semantic.pending} still pending. ` +
                'Run this again to continue; it picks up where it stopped. Keyword search covers ' +
                'the pending notes in the meantime.';
        return {
            attempted: s.attempted,
            refreshed: s.newlyEmbedded,
            alreadyCurrent: s.alreadyCurrent,
            failed: s.failed,
            remaining: coverage.semantic.pending,
            raced: s.raced,
            embedCalls: s.embedCalls,
            budget: max,
            corpusGeneration: corpus.state.generation,
            verifiedAt: corpus.state.verifiedAt,
            coverageComplete: coverage.coverageComplete,
            failures: s.failures,
            summary,
        };
    }
    // -- coverage and health --------------------------------------------------
    buildResponse(mode, results, threshold, corpus) {
        const coverage = this.buildCoverage(mode, corpus);
        const negativeResultsTrustworthy = mode === 'semantic' &&
            (this.probeCache?.passed ?? false) &&
            coverage.freshnessVerified &&
            coverage.coverageComplete;
        const response = {
            mode,
            results,
            coverage,
            threshold,
            negativeResultsTrustworthy,
        };
        const warning = this.coverageWarning(mode, coverage, results.length, negativeResultsTrustworthy);
        if (warning)
            response.warning = warning;
        return response;
    }
    /**
     * Coverage by SET DIFFERENCE, never by adding counts (tracker 4.1).
     *
     * `searchable = semanticPaths INTERSECT onDisk`, `pending = eligible MINUS
     * searchable`. Doing it this way makes three bug classes structurally
     * impossible rather than merely unlikely: a duplicate path cannot inflate what
     * was searched, a phantom cannot inflate anything, and plugin/supplemental
     * overlap cannot make the searched count exceed the vault. The old code added
     * `fromPlugin + supplemental` and subtracted from a total built out of the same
     * indexes, which is why it could report `unsearchable: 0` on a vault that was
     * 97% stale.
     */
    buildCoverage(mode, corpus) {
        const state = corpus.state;
        const searchable = new Set();
        for (const path of corpus.semanticSearchable) {
            if (state.onDisk.has(path))
                searchable.add(path);
        }
        const pending = new Set();
        for (const path of state.eligible)
            if (!searchable.has(path))
                pending.add(path);
        let fromPluginFresh = 0;
        let fromSupplemental = 0;
        for (const path of searchable) {
            if (state.supplementalFresh.has(path))
                fromSupplemental++;
            else if (state.pluginFresh.has(path))
                fromPluginFresh++;
        }
        let sections = 0;
        for (const list of corpus.sectionVectors.values())
            sections += list.length;
        // Lexical reads whatever it can read, which is every note minus the ones
        // that failed to read at all.
        const lexicalSearchable = state.onDisk.size - state.unreadable.size;
        const freshnessVerified = corpusIsClean(state);
        const coverageComplete = freshnessVerified && pending.size === 0 && mode === 'semantic';
        return {
            vaultNotes: state.onDisk.size,
            eligible: state.eligible.size,
            ineligible: state.ineligible.size,
            semantic: {
                searchable: searchable.size,
                pending: pending.size,
                fromPluginFresh,
                fromSupplemental,
                sections,
            },
            lexical: { searchable: lexicalSearchable },
            plugin: {
                sources: this.loader.getSourceCount(),
                fresh: state.pluginFresh.size,
                stale: state.pluginStale.size,
                phantom: state.pluginPhantoms.size,
                unreadable: state.pluginUnreadable.size,
            },
            errors: {
                inventory: state.errors.inventory.length,
                read: state.errors.read.length,
                hash: state.errors.hash.length,
                embed: state.errors.embed.length,
                unreadable: state.unreadable.size,
            },
            corpusGeneration: state.generation,
            verifiedAt: state.verifiedAt,
            freshnessVerified,
            coverageComplete,
        };
    }
    /**
     * The loud part. A caller that ignores everything else should still not be
     * able to read a degraded answer as a clean one.
     */
    coverageWarning(mode, coverage, resultCount, trustworthy) {
        const parts = [];
        if (mode === 'keyword') {
            parts.push('SEARCH IS DEGRADED: the embedding model did not load, so this answer came from ' +
                'literal keyword matching and will miss anything phrased differently. ' +
                'Do not report an empty or thin result as "the vault has nothing on this."');
        }
        if (!coverage.freshnessVerified) {
            parts.push(`FRESHNESS NOT VERIFIED: ${coverage.errors.inventory} directories, ` +
                `${coverage.errors.read} reads, ${coverage.errors.hash} hashes and ` +
                `${coverage.errors.embed} embeddings could not be accounted for, so these ` +
                'numbers are the best available rather than the truth.');
        }
        if (coverage.semantic.pending > 0) {
            parts.push(`${coverage.semantic.pending} of ${coverage.eligible} eligible notes have no ` +
                'verified-current vector yet, so semantic search cannot see them. They ARE ' +
                'covered by literal keyword matching, which runs over the whole vault, so a ' +
                'distinctive phrase will still find them.');
        }
        if (coverage.plugin.stale > 0) {
            parts.push(`${coverage.plugin.stale} Smart Connections vectors were dropped as stale ` +
                '(the notes changed after they were embedded). Open Obsidian to let the plugin ' +
                'catch up, or call refresh_search_index to embed them here.');
        }
        if (resultCount === 0) {
            parts.push(trustworthy
                ? `No matches above threshold. This was a full ${mode} search of ` +
                    `${coverage.semantic.searchable} of ${coverage.eligible} eligible notes with ` +
                    'freshness verified, so the vault genuinely appears to have nothing closer. ' +
                    'Lower the threshold to widen recall.'
                : 'This empty result is NOT evidence of absence. Say "not found in the verified ' +
                    'searchable index," never "absent from the vault," and use grep or a file read ' +
                    'when absence actually matters.');
        }
        return parts.length ? parts.join(' ') : undefined;
    }
    /**
     * The verdict, split into the questions it was conflating (tracker 6.1, 6.2).
     *
     * The old check asked "did we get results for notes we know are there," drew
     * the expected notes FROM the live index, and called a pass `alive`. That
     * tests REACHABILITY of whatever the index holds, and a corpus embedded in June
     * is perfectly reachable. So the probes are kept and honestly renamed, and
     * freshness is established mechanically from fingerprints instead of being
     * inferred from a probe that cannot see it.
     */
    async checkSearchHealth(canaryPath) {
        const corpus = await this.corpus.get({ skipIndexing: true });
        const coverage = this.buildCoverage('semantic', corpus);
        const targets = this.pickProbeTargets(corpus, canaryPath);
        const probes = [];
        let mode = 'semantic';
        for (const target of targets) {
            // Threshold deliberately low: this asks whether the note is reachable at
            // all, not whether it would rank well for a member's real question.
            const response = await this.searchByQuery(target.query, 10, 0.2);
            mode = response.mode;
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
        // A majority rather than a single hit: one miss is a ranking accident, a
        // clean sweep of misses is blindness.
        const majority = Math.ceil(probes.length / 2);
        const retrievalProbePassed = probes.length > 0 && probesPassed >= majority;
        this.probeCache = { passed: retrievalProbePassed, probes };
        const semanticReady = mode === 'semantic' && corpus.noteVectors.size > 0;
        const freshnessVerified = coverage.freshnessVerified;
        const coverageComplete = coverage.coverageComplete;
        const negativeResultsTrustworthy = semanticReady && retrievalProbePassed && freshnessVerified && coverageComplete;
        return {
            semanticReady,
            retrievalProbePassed,
            freshnessVerified,
            coverageComplete,
            negativeResultsTrustworthy,
            verifiedAt: corpus.state.verifiedAt,
            corpusGeneration: corpus.state.generation,
            alive: negativeResultsTrustworthy,
            mode,
            coverage,
            modelKey: this.embeddingModelKey,
            probes,
            probesPassed,
            probesRun: probes.length,
            verdict: buildVerdict({
                semanticReady,
                retrievalProbePassed,
                freshnessVerified,
                coverageComplete,
                negativeResultsTrustworthy,
                mode,
                coverage,
                probesPassed,
                probesRun: probes.length,
            }),
        };
    }
    /**
     * Query a note by its own title. If retrieval cannot find a note when handed
     * that note's title, it cannot find anything.
     *
     * Drawn from what the engine can actually RANK, not from the plugin alone:
     * sampling the plugin made the probe report "no notes are indexed" on a
     * working plugin-free vault, and a check that cries wolf gets ignored exactly
     * like one that stays silent when it should not.
     */
    pickProbeTargets(corpus, canaryPath) {
        const paths = Array.from(corpus.semanticSearchable);
        if (paths.length === 0)
            return [];
        const chosen = [];
        const canary = canaryPath ? corpus.state.resolvePath(canaryPath) : null;
        if (canary && paths.includes(canary))
            chosen.push(canary);
        // Deterministic spread, so repeated runs are comparable and one unlucky note
        // cannot flip the verdict on its own.
        const sorted = [...paths].sort();
        for (const fraction of [0.1, 0.5, 0.9]) {
            const candidate = sorted[Math.floor(sorted.length * fraction)];
            if (candidate && !chosen.includes(candidate))
                chosen.push(candidate);
        }
        return chosen.map((path) => ({ path, query: titleFromPath(path) }));
    }
}
function tokenize(queryText) {
    return Array.from(new Set(queryText
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter((t) => t.length > 1 && !STOPWORDS.has(t))));
}
/** Headings a note currently has, read from the note rather than from an index. */
function headingsFromMarkdown(content) {
    const out = [];
    for (const line of content.split(/\r?\n/)) {
        const m = /^#{1,6}\s+(.*)$/.exec(line);
        if (m && m[1].trim())
            out.push(m[1].trim());
    }
    return out;
}
/** Filename without directories or extension, hyphens and underscores as spaces. */
function titleFromPath(notePath) {
    const base = notePath.split(/[\\/]/).pop() || notePath;
    return base.replace(/\.md$/i, '').replace(/[-_]+/g, ' ').trim();
}
function buildVerdict(v) {
    const c = v.coverage;
    if (v.probesRun === 0 && c.semantic.searchable === 0) {
        return (`SEARCH HAS NOTHING TO SEARCH: ${c.vaultNotes} notes are on disk and none has a ` +
            'verified-current vector yet. Keyword matching still covers the whole vault, so ' +
            'literal phrases work. Call refresh_search_index to build the semantic index.');
    }
    if (v.mode === 'keyword') {
        return ('SEARCH IS DEGRADED: the embedding model did not load and this server is answering ' +
            'with literal keyword matching. Empty results from it mean nothing. Fix the model ' +
            'before trusting any "the vault has nothing on this" answer.');
    }
    if (!v.retrievalProbePassed) {
        return (`SEARCH IS BLIND: ${v.probesRun} notes were asked for by their own titles and ` +
            `${v.probesRun - v.probesPassed} did not come back. An empty result from this server ` +
            'cannot currently be trusted.');
    }
    if (!v.freshnessVerified) {
        return ('FRESHNESS COULD NOT BE VERIFIED: some notes could not be read, hashed or classified, ' +
            'so this server cannot say which vectors match what is on disk. Retrieval works; its ' +
            'silences do not mean anything yet.');
    }
    if (!v.coverageComplete) {
        return (`SEARCH IS CONVERGING: ${c.semantic.searchable} of ${c.eligible} eligible notes have a ` +
            `verified-current vector and ${c.semantic.pending} are still pending. What it finds is ` +
            'real and current. An empty result proves nothing yet, so do not report "the vault has ' +
            'nothing on this" until coverageComplete is true. Keyword matching covers the pending ' +
            'notes meanwhile.');
    }
    return (`Search is current: all ${c.eligible} eligible notes have a verified-current vector, ` +
        `${v.probesPassed} of ${v.probesRun} probes came back, freshness verified at ` +
        `${c.verifiedAt}. An empty result from this server IS evidence of absence.`);
}
//# sourceMappingURL=search-engine.js.map