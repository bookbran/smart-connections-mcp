/**
 * The freshness fingerprint (tracker 1.3).
 *
 * A vector is safe to rank only when the content it was built from is still the
 * content on disk. This module is the only thing allowed to answer "is this the
 * same note as before."
 *
 * NOT MTIME. That was the first draft and it was wrong, and the evidence was
 * already in this codebase: `second-brain-dashboard@e2b0e66` moved the recency
 * signal off mtime because mtime records when a PROCESS wrote a file, not when a
 * person changed it. A git pull, a checkout, a clone, a restore, or a sync
 * rewrites every mtime to now. This vault lives on two machines and travels by
 * git, so an mtime test would declare the entire vault stale on every machine
 * switch: thousands of embed calls against a 3,000-call budget, several runs to
 * converge, every time. Fails safe, but wastefully enough to feel broken.
 *
 * NOT SIZE. Stable across git, and blind to a same-size edit, which is the
 * single most obvious way to fool it.
 *
 * NOT BOTH, AND NOT AS A "CHEAP SKIP" BEFORE HASHING. An earlier draft kept
 * mtime+size as a fast path: unchanged pair means do not bother re-hashing. That
 * is a false-fresh generator. A same-size edit with a preserved timestamp, which
 * a copy tool or a deliberate `touch -r` produces, makes the cache reuse an old
 * digest without ever reading the file and declare changed content unchanged.
 * That is the exact failure this entire build exists to remove, reintroduced as
 * an optimization. Version 1 always hashes. Hashing markdown is cheap next to
 * embedding it, and if a skip cache is ever added it must be documented as
 * probabilistic unless something authoritative backs it.
 *
 * CANONICAL TEXT, NOT RAW BYTES. `core.autocrlf=true` is set on this machine, so
 * git hands the same logical note to two machines with different line endings.
 * Measured on this vault while writing this: CLAUDE.md is LF on disk and
 * context/strategy.md is CRLF, in the same working tree. A raw-byte hash would
 * call that a change and invalidate the world on every checkout.
 */

import { createHash } from 'crypto';

/**
 * Stored beside every digest we produce. A future change to canonicalization
 * bumps this, which invalidates deliberately instead of silently reusing vectors
 * built under different rules. The chunker learned this lesson the hard way:
 * without a version, an unchanged file keeps vectors from the old splitter
 * forever, because nothing about the file ever changes to invalidate them.
 */
export const CONTENT_HASH_ALGORITHM = 'canonical-markdown-sha256-v1';

/**
 * The exact text form that gets hashed, chunked and embedded.
 *
 * Deliberately conservative: it removes only the two things that change without
 * the note changing. Trailing whitespace, blank-line runs, heading style and
 * frontmatter are all preserved, because they are things a member can actually
 * edit and a freshness test that ignored them would be a false-fresh generator
 * in a different costume.
 *
 *  - strip a leading BOM (an editor can add or remove one invisibly)
 *  - CRLF and lone CR to LF (git rewrites these per machine)
 *  - everything else exactly as it was
 */
export function canonicalizeMarkdown(raw: string): string {
  let text = raw;
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

/** Hash of already-canonical text. Use when you are holding the exact string you embedded. */
export function hashCanonicalText(canonical: string): string {
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

/**
 * Canonicalize then hash. The pair a caller wants when it has raw file content.
 *
 * Returns the canonical text too, because the single most important invariant in
 * this build is that the text that was hashed is the same text that got chunked
 * and embedded. Handing back both makes it awkward to accidentally hash one
 * string and embed another, which is the edit-during-embed race in tracker 2.2.
 */
export function canonicalContentHash(raw: string): { canonical: string; hash: string } {
  const canonical = canonicalizeMarkdown(raw);
  return { canonical, hash: hashCanonicalText(canonical) };
}

/** A digest plus the rules that produced it. Persisted with every vector we own. */
export interface ContentFingerprint {
  contentHash: string;
  contentHashAlgorithm: string;
}

export function fingerprint(hash: string): ContentFingerprint {
  return { contentHash: hash, contentHashAlgorithm: CONTENT_HASH_ALGORITHM };
}

/**
 * Whether a stored fingerprint vouches for the content we are holding now.
 *
 * A missing hash, a missing algorithm id, or an algorithm we no longer use all
 * mean UNVERIFIED, and unverified means stale. There is no third answer: the
 * whole bug was a system treating "I have no evidence about this" as "this is
 * fine."
 */
export function fingerprintMatches(
  stored: Partial<ContentFingerprint> | undefined | null,
  currentHash: string
): boolean {
  if (!stored) return false;
  if (stored.contentHashAlgorithm !== CONTENT_HASH_ALGORITHM) return false;
  if (!stored.contentHash) return false;
  return stored.contentHash === currentHash;
}
