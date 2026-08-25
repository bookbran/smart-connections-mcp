/**
 * The only corpus retrieval is allowed to rank against (tracker 2.3, 5.1, 5.6).
 *
 * -- Why a facade rather than a filter at each call site --
 *
 * Filtering `pluginVectors()` and forgetting `getBlockVectors()` leaves the bug
 * fully intact, because `denseScores` takes the MAX across a note's evidence and
 * a stale block can be the strongest signal for a note. That is not a
 * hypothetical: on this vault, a stale note ranked 6th of 55 in the lexical
 * scorer for a literal phrase and still never appeared in fused output, because
 * its stale vector earned a terrible dense rank and RRF buried a lexical-only
 * hit under notes scoring in both lists. Dropping stale vectors does not merely
 * remove wrong answers, it RESTORES the lexical fallback path.
 *
 * So there is one object, it is built once per operation, and it holds only
 * vectors that a reconciled snapshot vouched for. Whole-note and block together,
 * plugin and supplemental together. A retrieval surface that wants evidence asks
 * this; nothing downstream re-derives freshness or reaches past it.
 *
 * -- Why nothing here can quietly regress --
 *
 * Six months from now somebody adds `find_related_projects()` and naturally
 * reaches for `loader.getSources()`, and this whole build silently unwinds in
 * one function. `test/no-raw-corpus-access.test.mjs` fails the build when a
 * retrieval module does that. Prose does not enforce anything; a failing test
 * does.
 */
import { CorpusReconciler } from './corpus-state.js';
import { buildSupplementalIndex, DEFAULT_EMBED_BUDGET, } from './vault-indexer.js';
/**
 * Owns the reconciler and hands out corpora.
 *
 * `get()` reconciles EVERY time, which is the contract from tracker 1.6: a
 * server whose corpus was correct at launch is a smaller version of this bug.
 * Measured at ~300ms for 702 notes, which is small next to a single embedding
 * call, so correctness does not need an exception here.
 */
export class CorpusProvider {
    loader;
    vaultPath;
    reconciler;
    constructor(loader, vaultPath) {
        this.loader = loader;
        this.vaultPath = vaultPath;
        this.reconciler = new CorpusReconciler(vaultPath, loader);
    }
    /** For callers that need only the classification, with no embedding work. */
    async snapshot() {
        return this.reconciler.reconcile();
    }
    async get(options = {}) {
        let state = await this.reconciler.reconcile();
        let supplemental;
        if (options.skipIndexing) {
            // A budget of zero still loads every vector the snapshot verified; it just
            // never spends an embed call. That is what a caller wanting "rank against
            // what is already current" means, and it keeps one code path rather than a
            // second, subtly different assembly.
            supplemental = await buildSupplementalIndex(this.vaultPath, state, { maxEmbeddings: 0 });
        }
        else {
            supplemental = await buildSupplementalIndex(this.vaultPath, state, {
                maxEmbeddings: options.maxEmbeddings ?? DEFAULT_EMBED_BUDGET,
                order: options.order,
                onFailure: (path, message) => this.reconciler.recordEmbedFailure(path, message),
                onSuccess: (path) => this.reconciler.clearEmbedFailure(path),
            });
            // Re-reconcile when the vault changed underneath us, so every set in the
            // returned corpus comes from ONE moment rather than being stitched
            // together from a before-snapshot and an after-list. Stitching is how
            // `freshnessVerified` would end up meaning "mostly, at various times."
            if (supplemental.newlyEmbedded > 0) {
                state = await this.reconciler.reconcile();
            }
        }
        return this.assemble(state, supplemental);
    }
    assemble(state, supplemental) {
        const noteVectors = new Map();
        const sectionVectors = new Map();
        const blockHeadings = new Map();
        const modelKey = this.loader.getEmbeddingModelKey();
        // Plugin vectors, but ONLY where the snapshot verified them. `pluginFresh`
        // is already keyed by the disk's spelling, so nothing here re-canonicalizes.
        for (const [rawPath, source] of this.loader.getSources()) {
            const path = state.resolvePath(rawPath);
            if (!path || !state.pluginFresh.has(path))
                continue;
            const vec = source.embeddings?.[modelKey]?.vec;
            if (vec?.length)
                noteVectors.set(path, vec);
            const headings = Object.keys(source.blocks || {});
            if (headings.length)
                blockHeadings.set(path, headings);
        }
        // Plugin BLOCK vectors, gated on the same verdict. Blocks inherit their
        // source's freshness rather than being validated alone: a block's own hash
        // covers block text, but the line ranges that would locate that text are
        // themselves stale once the file changes. If the source verifies, the file
        // is byte-identical to what the plugin read, so its blocks are too.
        for (const [rawPath, blocks] of this.loader.getBlockVectors()) {
            const path = state.resolvePath(rawPath);
            if (!path || !state.pluginFresh.has(path))
                continue;
            const usable = blocks.filter((b) => b.vec?.length);
            if (usable.length)
                sectionVectors.set(path, usable);
        }
        // Our own vectors. These carry our canonical fingerprint, so they survive a
        // line-ending flip that costs the plugin its whole index.
        for (const [path, vec] of supplemental.vectors) {
            if (vec.length)
                noteVectors.set(path, vec);
        }
        for (const [path, vecs] of supplemental.sections) {
            const existing = sectionVectors.get(path) ?? [];
            const ours = vecs.map((vec) => ({ heading: '', vec }));
            sectionVectors.set(path, existing.concat(ours));
        }
        const semanticSearchable = new Set();
        for (const path of noteVectors.keys())
            semanticSearchable.add(path);
        for (const path of sectionVectors.keys())
            semanticSearchable.add(path);
        // Existence is the disk's call, not the index's. A vector for a note that is
        // no longer on disk is a phantom and must not count as searchable.
        for (const path of Array.from(semanticSearchable)) {
            if (!state.onDisk.has(path))
                semanticSearchable.delete(path);
        }
        return {
            state,
            noteVectors,
            sectionVectors,
            semanticSearchable,
            supplemental,
            blockHeadings,
        };
    }
}
//# sourceMappingURL=current-corpus.js.map