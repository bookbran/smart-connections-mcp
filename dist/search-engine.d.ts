/**
 * Retrieval, and the facts a caller needs to judge it.
 *
 * Everything semantic in this file ranks against `CurrentCorpus` and nothing
 * else. That is the whole architectural point: `search_notes` returning current
 * results while `get_similar_notes` still answered from the plugin's old
 * snapshot would be the same bug with a smaller blast radius.
 */
import type { SimilarNote, ConnectionGraph, NoteContent, SearchResponse, SearchHealthReport, RefreshReport } from './types.js';
import { type CurrentCorpus } from './current-corpus.js';
import type { SmartConnectionsLoader } from './smart-connections-loader.js';
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
export declare const DEFAULT_INTERACTIVE_EMBED_BUDGET = 40;
/**
 * A pending set at or below this size is finished outright by a health check
 * rather than trickled. See `healthBudget`.
 */
export declare const SMALL_ENOUGH_TO_FINISH_AT_ONCE = 60;
export declare class SearchEngine {
    private readonly loader;
    private readonly corpus;
    private readonly embeddingModelKey;
    /**
     * Probe results, cached for the process.
     *
     * Probes test MACHINERY: can retrieval return a note it is holding a vector
     * for. Machinery does not change between queries, and re-embedding three
     * title queries on every search would be a real cost for no new information.
     * `check_search_health` always re-runs them, so the explicit check is never
     * answered from a cache.
     */
    private probeCache;
    /**
     * What unrelated text scores against THIS corpus, cached per generation.
     *
     * Fixed gibberish anchors, embedded once per corpus generation and scored
     * against every vector the corpus holds. The anchors are constants, not
     * random, so two runs measure the same thing. Why this exists: absolute
     * similarity floors sit below the embedding model's baseline for unrelated
     * text (measured: pure gibberish at 0.62-0.64 on bge-micro-v2, sailing over
     * the 0.4 default threshold), so a query about something absent from the
     * vault returns a confident-looking list and the empty-result honesty
     * machinery never fires — gibberish never produces an empty result.
     */
    private noiseCache;
    constructor(loader: SmartConnectionsLoader);
    /**
     * Semantic search over the vault.
     *
     * Interactive shape, from tracker 7.1: the lexical corpus is the whole vault
     * and answers immediately, a SMALL bounded number of pending notes get
     * repaired, and the query returns. It never drains the general backlog
     * synchronously.
     */
    searchByQuery(queryText: string, limit?: number, threshold?: number): Promise<SearchResponse>;
    /**
     * Fixed anchors. Changing these changes what every vault measures; don't.
     *
     * Eight rather than three, and deliberately varied in token count and
     * shape, because the ceiling is a MAX over samples from a distribution:
     * measured while building this, a fourth gibberish string scored 0.527
     * against a ceiling of 0.513 taken from only three anchors. More samples
     * push the measured max toward the distribution's real tail. Length varies
     * because similarity drifts with token count on these models.
     */
    private static readonly NOISE_ANCHORS;
    /**
     * Measure (or reuse) the noise ceiling for this corpus generation.
     *
     * Never blocks or fails a search: any trouble here returns null and the
     * envelope simply omits the field. Cost when it does run: three short
     * embeds on a model that is already loaded, then cosine over vectors
     * already in memory. Cached per generation, exactly like the probe cache
     * and for the same reason — machinery does not change between queries.
     */
    private noiseCeilingFor;
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
    private repairOrder;
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
    private denseScores;
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
    private rankFused;
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
    searchByKeyword(queryText: string, corpus: CurrentCorpus, limit?: number, threshold?: number): SimilarNote[];
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
    getSimilarNotes(notePath: string, threshold?: number, limit?: number): Promise<SimilarNote[]>;
    /** Nearest neighbours for a caller-supplied vector (tracker 5.3). */
    getEmbeddingNeighbors(embeddingVector: number[], k?: number, threshold?: number): Promise<SimilarNote[]>;
    /**
     * A multi-level connection graph (tracker 5.3).
     *
     * Inherits the fix through `getSimilarNotes`, which is the point of having one
     * corpus rather than a filter per call site. The test proves it rather than
     * assuming it.
     */
    getConnectionGraph(notePath: string, depth?: number, threshold?: number, maxPerLevel?: number): Promise<ConnectionGraph>;
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
    getNoteWithContext(notePath: string): Promise<NoteContent>;
    /**
     * Vault-world numbers, not plugin-world (tracker 5.4).
     *
     * `totalNotes` used to be `loader.getSources().size`, the size of the INDEX.
     * On this vault that reported 525 for a 702-note vault and called it the total.
     */
    getStats(): Promise<{
        vaultNotes: number;
        pluginSources: number;
        pluginFresh: number;
        supplemental: number;
        semanticSearchable: number;
        semanticPending: number;
        totalSections: number;
        embeddingDimension: number;
        modelKey: string;
        corpusGeneration: number;
        verifiedAt: string;
    }>;
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
    refreshSearchIndex(budget?: number): Promise<RefreshReport>;
    private buildResponse;
    /**
     * Results that only score what gibberish scores are not findings.
     *
     * This closes the gap the empty-result machinery cannot reach: a query about
     * something ABSENT never returns empty (ranking always ranks something), so
     * `negativeResultsTrustworthy` never gets its moment. The comparison is
     * against the top result: if even the best hit sits at or under the measured
     * noise ceiling, the whole list is unrelated text wearing scores.
     */
    private noiseWarning;
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
    private buildCoverage;
    /**
     * The loud part. A caller that ignores everything else should still not be
     * able to read a degraded answer as a clean one.
     */
    private coverageWarning;
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
    checkSearchHealth(canaryPath?: string): Promise<SearchHealthReport>;
    /**
     * How much embedding a health check may do.
     *
     * It has to do SOME, and this was found the hard way while verifying the
     * fresh-download path: a brand new brain has no vectors, so there were no
     * probe targets, so no probes ran, so nothing got embedded, so it still had no
     * vectors. `check_search_health` on a brain that had installed itself
     * perfectly reported "SEARCH HAS NOTHING TO SEARCH" forever, and would have
     * kept reporting it until somebody happened to run a query. Chicken and egg,
     * and the egg was on the fresh-install path, which is the one that matters
     * most.
     *
     * So the rule is: FINISH the job when the job is small, take a bounded slice
     * when it is not. A brand new brain is small and converges in seconds during
     * the check that was going to run anyway. A migrated vault arriving with
     * hundreds of notes gets the same small slice an interactive query gets, and
     * an honest verdict telling the agent to call `refresh_search_index`.
     *
     * 60 notes is roughly 660 embed calls at this vault's measured 10.6 sections
     * per note, comfortably inside the 3,000 total.
     */
    private healthBudget;
    /**
     * Query a note by its own title. If retrieval cannot find a note when handed
     * that note's title, it cannot find anything.
     *
     * Drawn from what the engine can actually RANK, not from the plugin alone:
     * sampling the plugin made the probe report "no notes are indexed" on a
     * working plugin-free vault, and a check that cries wolf gets ignored exactly
     * like one that stays silent when it should not.
     */
    private pickProbeTargets;
}
//# sourceMappingURL=search-engine.d.ts.map