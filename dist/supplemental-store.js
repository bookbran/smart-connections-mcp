/**
 * Where the vectors this server owns are kept, and what makes one trustworthy.
 *
 * Split out of `vault-indexer.ts` so the corpus classifier and the indexer can
 * both read it without importing each other. That circularity is not a build
 * technicality: the classifier has to know which supplemental vectors are
 * current in order to compute what still needs embedding, and the indexer has to
 * know what still needs embedding in order to produce vectors. Putting the store
 * underneath both is what keeps "is this current" a single answer.
 *
 * THE CACHE KEY IS THE CONTENT, NOT THE FILE. The previous version keyed reuse
 * on `size` and `mtime`. That is the bug this build exists to remove, one layer
 * down from where it was found. Every entry now carries the canonical content
 * hash of the exact text that was chunked and embedded, plus the id of the
 * algorithm that produced it.
 *
 * LEGACY ENTRIES ARE DROPPED, ONCE. An entry written before this change has no
 * fingerprint, so there is no way to learn what content produced its vector.
 * Comparing a fresh hash against nothing proves nothing, and bootstrapping trust
 * from metadata already judged non-authoritative is how the original bug
 * happened. They are discarded on load and re-embedded through the normal path.
 * The cost is one full re-embed. The alternative is keeping vectors we cannot
 * vouch for, which is the thing being fixed.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { CONTENT_HASH_ALGORITHM, fingerprintMatches } from './content-hash.js';
import { canonicalPath } from './canonical-path.js';
export const SUPPLEMENTAL_CACHE_FILE = '.smart-env/mcp-supplemental.json';
/**
 * Bumped when the on-disk shape changes in a way older readers would
 * misinterpret. Version 2 introduces content fingerprints; version 1 and the
 * unversioned original are dropped rather than guessed at.
 */
export const SUPPLEMENTAL_CACHE_VERSION = 2;
/**
 * Bump whenever chunking changes shape. The content hash cannot detect it: the
 * file is identical and the chunks derived from it are not, so without this an
 * unchanged note keeps vectors built by the old splitter forever. Learned by
 * shipping a chunker fix that would otherwise have reached only the notes Dan
 * happened to edit afterwards.
 */
export const CHUNKER_VERSION = 3;
function emptyCache() {
    return {
        version: SUPPLEMENTAL_CACHE_VERSION,
        algorithm: CONTENT_HASH_ALGORITHM,
        chunker: CHUNKER_VERSION,
        entries: {},
    };
}
/**
 * A cache entry is usable only when it can prove which content it came from.
 *
 * Four independent reasons to refuse, and all of them mean the same thing: we
 * cannot vouch for this vector, so it does not get ranked.
 */
export function entryIsCurrent(entry, currentHash) {
    if (!entry || !currentHash)
        return false;
    if (entry.chunker !== CHUNKER_VERSION)
        return false;
    if (!Array.isArray(entry.vec) || entry.vec.length === 0)
        return false;
    return fingerprintMatches(entry, currentHash);
}
export function loadSupplementalCache(vaultPath) {
    const file = join(vaultPath, SUPPLEMENTAL_CACHE_FILE);
    if (!existsSync(file))
        return emptyCache();
    let parsed;
    try {
        parsed = JSON.parse(readFileSync(file, 'utf-8'));
    }
    catch {
        // A corrupt cache costs re-embedding, which is slow. Trusting a corrupt
        // cache costs wrong answers, which is the bug. Start over.
        return emptyCache();
    }
    const cache = parsed;
    if (!cache || typeof cache !== 'object')
        return emptyCache();
    if (cache.version !== SUPPLEMENTAL_CACHE_VERSION)
        return emptyCache();
    if (cache.algorithm !== CONTENT_HASH_ALGORITHM)
        return emptyCache();
    if (!cache.entries || typeof cache.entries !== 'object')
        return emptyCache();
    // Re-key through the canonical path function rather than trusting whatever
    // spelling was written last time. An entry that no longer canonicalizes to
    // anything is dropped instead of becoming a key nothing can ever match.
    const out = emptyCache();
    for (const [rawPath, entry] of Object.entries(cache.entries)) {
        const path = canonicalPath(rawPath);
        if (!path)
            continue;
        if (!entry || typeof entry !== 'object')
            continue;
        const e = entry;
        if (!Array.isArray(e.vec) || !Array.isArray(e.sections))
            continue;
        if (e.contentHashAlgorithm !== CONTENT_HASH_ALGORITHM)
            continue;
        if (typeof e.contentHash !== 'string' || !e.contentHash)
            continue;
        out.entries[path] = e;
    }
    return out;
}
export function saveSupplementalCache(vaultPath, cache) {
    try {
        // On a machine where Smart Connections has never run there is no
        // `.smart-env` to write into. Without this the cache silently failed to
        // save and every startup re-embedded the whole vault, which is precisely
        // the no-Obsidian case this server exists to support.
        mkdirSync(join(vaultPath, '.smart-env'), { recursive: true });
        // The cache is megabytes of vectors written INSIDE a vault that is very
        // often a git repo, and no vault's own .gitignore can be assumed to cover
        // it — measured 2026-08-28: an 8MB cache sitting untracked in a live
        // vault, one `git add -A` from history. The directory ignores itself; a
        // member's own ignore file, if they wrote one here, is never rewritten.
        const selfIgnore = join(vaultPath, '.smart-env', '.gitignore');
        if (!existsSync(selfIgnore))
            writeFileSync(selfIgnore, '*\n', 'utf-8');
        writeFileSync(join(vaultPath, SUPPLEMENTAL_CACHE_FILE), JSON.stringify(cache), 'utf-8');
    }
    catch {
        // Losing the cache costs time on the next run and nothing else.
    }
}
//# sourceMappingURL=supplemental-store.js.map