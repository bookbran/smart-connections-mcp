/**
 * Producing the vectors this server owns (tracker 2.1, 2.2).
 *
 * -- What changed, and why it is not a refactor --
 *
 * This used to embed "every note the plugin has not indexed", expressed as
 * `!knownPaths.has(p)`. That predicate answers a question about the INDEX, and
 * the question that matters is about the NOTE: does this note have a vector
 * built from the text currently on disk. A note the plugin indexed in June and
 * the member edited in August passed `knownPaths.has(p)` and was skipped, so its
 * June vector kept answering queries as if it were current.
 *
 * The indexer no longer decides any of that. It consumes `semanticPending` from
 * the corpus snapshot, which is a set operation against one definition of
 * freshness rather than a second implementation of it. That is the whole point
 * of Phase 1 existing first: without it, this file would have grown its own
 * freshness check and the next tool would have grown a third.
 *
 * -- The race this closes (tracker 2.2) --
 *
 *     read file -> hash A -> begin embedding -> member edits file (content B)
 *               -> embedding finishes -> vector installed as "current"   WRONG
 *
 * Embedding a 700-note vault takes minutes, and a member editing a note during
 * that window is not an exotic case, it is Tuesday. The fix has two halves:
 *
 *   1. Read the content ONCE, canonicalize it, hash THAT SAME TEXT, chunk THAT
 *      SAME TEXT, embed those chunks. There is exactly one string in play, so
 *      there is no opportunity to hash one thing and embed another.
 *   2. Before treating the result as current, read the file again. If its hash
 *      moved while we were working, the vector is still cached under the hash it
 *      was actually built from, so it costs nothing and may be useful if the
 *      member reverts, but it is NOT reported as current and the note stays
 *      pending.
 *
 * The invariant, stated once: a current vector carries the fingerprint of
 * exactly the content it was built from, and that fingerprint still equals disk.
 *
 * -- Chunking --
 *
 * Notes are split on markdown headings and each section embedded separately,
 * mirroring what Smart Connections does and the actual reason its index is
 * better. A note vector is truncated to the model's window, so on a vault of
 * ordinary multi-thousand-character notes it represents the opening and nothing
 * else. Measured on this vault, retrieving a note from a passage in its own
 * body: recall@1 of 15% on note vectors against 57% on per-section vectors.
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { embedText } from './embedder.js';
import { canonicalContentHash, CONTENT_HASH_ALGORITHM } from './content-hash.js';
import { CHUNKER_VERSION, loadSupplementalCache, saveSupplementalCache, } from './supplemental-store.js';
/**
 * Budget in EMBED CALLS, not notes, because a note costs one call for itself
 * plus one per heading section. Measured here at 10.6 sections per note, so a
 * per-note cap of 2000 quietly became roughly 21,000 calls and the old "about
 * thirty seconds" promise became minutes, landing on a member's very first
 * query.
 *
 * Never widen this as the fix for a backlog. A backlog gets better scheduling
 * and a deliberate catch-up path; see `refresh_search_index`.
 */
export const DEFAULT_EMBED_BUDGET = 3000;
export function emptySupplementalIndex() {
    return {
        vectors: new Map(),
        sections: new Map(),
        attempted: 0,
        newlyEmbedded: 0,
        alreadyCurrent: 0,
        failed: 0,
        raced: 0,
        remaining: 0,
        embedCalls: 0,
        failures: [],
    };
}
/**
 * Break one block of text into pieces that each fit `budget`.
 *
 * Line-first, because a markdown list is semantically a sequence of lines and
 * cutting between them preserves meaning. Only a single line longer than the
 * whole budget falls through to a character cut, which is rare and still better
 * than handing the embedder something it will silently truncate.
 */
function hardWrap(text, budget) {
    if (text.length <= budget)
        return [text];
    const out = [];
    let buf = [];
    let size = 0;
    const flush = () => {
        if (buf.length)
            out.push(buf.join('\n'));
        buf = [];
        size = 0;
    };
    for (const line of text.split('\n')) {
        if (line.length > budget) {
            flush();
            for (let i = 0; i < line.length; i += budget)
                out.push(line.slice(i, i + budget));
            continue;
        }
        if (size + line.length + 1 > budget)
            flush();
        buf.push(line);
        size += line.length + 1;
    }
    flush();
    return out;
}
/**
 * Split a note into heading-delimited sections small enough to embed whole.
 *
 * The note's path rides on every chunk: location and filename carry real topic
 * signal, and a bare section body often does not say what it is about.
 *
 * Expects CANONICAL text. The `\r` handling that used to live here is gone
 * because canonicalization already removed it, and two places normalizing line
 * endings is two places that can disagree about what was hashed.
 */
export function splitIntoSections(relPath, text, maxChars = 1100) {
    const lines = text.split('\n');
    const sections = [];
    let headingTrail = [];
    let buf = [];
    const flush = () => {
        const body = buf.join('\n').trim();
        buf = [];
        if (body.length < 40)
            return; // too short to carry meaning on its own
        const context = [relPath, ...headingTrail].join(' > ');
        if (context.length + body.length <= maxChars) {
            sections.push(`${context}\n\n${body}`);
            return;
        }
        const budget = Math.max(200, maxChars - context.length);
        let chunk = [];
        let size = 0;
        const flushChunk = () => {
            if (!chunk.length)
                return;
            sections.push(`${context}\n\n${chunk.join('\n\n')}`);
            chunk = [];
            size = 0;
        };
        for (const para of body.split(/\n\s*\n/)) {
            // A paragraph can exceed the whole budget on its own, and on this vault it
            // routinely does: a tracker phase is forty `- [ ]` lines with no blank line
            // anywhere, so paragraph splitting returns one 11k-character blob.
            // Splitting only on blank lines emitted chunks far larger than the model
            // window and `embedText` silently truncated them, which is the exact
            // blindness sections were introduced to remove.
            for (const piece of hardWrap(para, budget)) {
                if (size + piece.length > budget)
                    flushChunk();
                chunk.push(piece);
                size += piece.length;
            }
        }
        flushChunk();
    };
    for (const line of lines) {
        const m = /^(#{1,6})\s+(.*)$/.exec(line);
        if (m) {
            flush();
            const depth = m[1].length;
            headingTrail = headingTrail.slice(0, depth - 1);
            headingTrail[depth - 1] = m[2].trim();
            headingTrail = headingTrail.filter((h) => h !== undefined);
            continue;
        }
        buf.push(line);
    }
    flush();
    // A note with no headings at all still needs chunking, so fall back to the
    // whole body run through the same paragraph splitter.
    if (sections.length === 0 && text.trim().length >= 40) {
        headingTrail = [];
        buf = lines;
        flush();
    }
    return sections;
}
/**
 * Load every current supplemental vector, and embed as much of the pending set
 * as the budget allows.
 *
 * Note what is NOT here any more: there is no `knownPaths`, no `statSync`, no
 * size comparison and no mtime comparison. Freshness arrives already decided.
 */
export async function buildSupplementalIndex(vaultPath, state, options = {}) {
    const maxEmbeddings = options.maxEmbeddings ?? DEFAULT_EMBED_BUDGET;
    const cache = loadSupplementalCache(vaultPath);
    const result = emptySupplementalIndex();
    // Everything the snapshot already verified. No I/O, no decisions.
    for (const path of state.supplementalFresh) {
        const entry = cache.entries[path];
        if (!entry)
            continue;
        result.vectors.set(path, entry.vec);
        if (entry.sections.length)
            result.sections.set(path, entry.sections);
        result.alreadyCurrent++;
    }
    const pending = options.order?.length
        ? options.order.filter((p) => state.semanticPending.has(p))
        : Array.from(state.semanticPending);
    let cacheDirty = false;
    let reached = 0;
    for (const path of pending) {
        if (result.embedCalls >= maxEmbeddings)
            break;
        reached++;
        result.attempted++;
        const entry = state.onDisk.get(path);
        if (!entry)
            continue;
        const outcome = await embedOne(vaultPath, entry.diskPath, path, cache, maxEmbeddings - result.embedCalls);
        result.embedCalls += outcome.embedCalls;
        if (outcome.status === 'failed') {
            result.failed++;
            result.failures.push({ path, message: outcome.message });
            options.onFailure?.(path, outcome.message);
            if (outcome.fatal)
                break; // model is gone; the rest of this run is pointless
            continue;
        }
        cacheDirty = true;
        result.newlyEmbedded++;
        options.onSuccess?.(path);
        if (outcome.status === 'raced') {
            // Cached under the hash it was built from, so the next reconciliation sees
            // it as stale and re-embeds. Deliberately NOT reported as current.
            result.raced++;
            continue;
        }
        result.vectors.set(path, outcome.vec);
        if (outcome.sections.length)
            result.sections.set(path, outcome.sections);
    }
    result.remaining = Math.max(0, pending.length - reached);
    if (cacheDirty)
        saveSupplementalCache(vaultPath, cache);
    return result;
}
/**
 * Embed one note, binding the vector to the exact content instance that produced
 * it.
 *
 * The ordering here is the whole safety argument, so it is written out rather
 * than left to be inferred: read once, canonicalize that string, hash that
 * canonical string, chunk that same canonical string, embed those chunks, then
 * re-read and compare before calling any of it current.
 */
async function embedOne(vaultPath, diskPath, canonicalKey, cache, remainingBudget) {
    const abs = join(vaultPath, diskPath);
    let raw;
    try {
        raw = readFileSync(abs, 'utf-8');
    }
    catch (e) {
        return {
            status: 'failed',
            message: e instanceof Error ? e.message : String(e),
            fatal: false,
            embedCalls: 0,
        };
    }
    const { canonical, hash } = canonicalContentHash(raw);
    let embedCalls = 0;
    // `embedText` owns truncation, since only it knows the model's real limit and
    // it steps the budget down if a note tokenizes densely. The path goes in ahead
    // of the body because a note's location and filename say a lot about its
    // topic, and the opening carries the rest.
    let vec;
    try {
        vec = await embedText(`${canonicalKey}\n\n${canonical}`);
    }
    catch (e) {
        return {
            status: 'failed',
            message: e instanceof Error ? e.message : String(e),
            fatal: true,
            embedCalls,
        };
    }
    if (!vec.length) {
        return { status: 'failed', message: 'embedding model returned nothing', fatal: true, embedCalls };
    }
    embedCalls++;
    // A note is finished once started rather than half-sectioned, so a note never
    // lands in the cache with a partial section list. The budget is checked per
    // note, not per section.
    const sections = [];
    for (const section of splitIntoSections(canonicalKey, canonical)) {
        if (embedCalls >= remainingBudget && sections.length > 0)
            break;
        let sv;
        try {
            sv = await embedText(section);
        }
        catch (e) {
            return {
                status: 'failed',
                message: e instanceof Error ? e.message : String(e),
                fatal: true,
                embedCalls,
            };
        }
        if (!sv.length)
            break;
        sections.push(sv);
        embedCalls++;
    }
    cache.entries[canonicalKey] = {
        vec,
        sections,
        chunker: CHUNKER_VERSION,
        contentHash: hash,
        contentHashAlgorithm: CONTENT_HASH_ALGORITHM,
        embeddedAt: Date.now(),
    };
    // The second half of closing the race. Embedding a vault takes minutes and a
    // member editing a note during that window is ordinary.
    let after;
    try {
        after = readFileSync(abs, 'utf-8');
    }
    catch {
        // Deleted or locked mid-run. The cache entry is still correct about what it
        // was built from; it simply is not current.
        return { status: 'raced', embedCalls };
    }
    if (canonicalContentHash(after).hash !== hash) {
        return { status: 'raced', embedCalls };
    }
    return { status: 'current', vec, sections, embedCalls };
}
//# sourceMappingURL=vault-indexer.js.map