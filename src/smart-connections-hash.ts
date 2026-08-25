/**
 * Reproducing the Smart Connections content hash, so its existing vectors can be
 * REUSED rather than thrown away (tracker 1.4).
 *
 * ── What this is ──────────────────────────────────────────────────────────────
 *
 * Lifted from the plugin bundle itself, `smart-utils/create_hash.js` inside
 * `.obsidian/plugins/smart-connections/main.js`. It is murmur3-32 over the JS
 * string, rendered as unsigned base36. That is where the six-character
 * `"v9osj6"`-shaped values in `.smart-env` come from.
 *
 * ── Why we did not just take its word for it ─────────────────────────────────
 *
 * Knowing how to COMPUTE a hash is not the same as knowing what it COVERS, and
 * concluding "reproduced" from one lucky match is how this bug got shipped in
 * the first place. So it was characterized against a real 525-source index on
 * 2026-08-25, and read in the plugin source rather than inferred from behaviour:
 *
 *   1. `create_hash(content)` is `murmur_hash_32_alphanumeric(content)`, over the
 *      RAW string the vault adapter read from disk.
 *   2. `read()` writes `data.last_read = { hash, at }` on every read.
 *   3. import copies it: `data.last_import = { mtime, size, at, hash:
 *      data.last_read.hash }`.
 *   4. and the embed queue, ONLY after `embed_batch` has resolved and set
 *      `entity.vec`, copies the STRING: `item.embed_hash = item.read_hash`,
 *      landing in `data.embeddings[model_key].last_embed.hash`.
 *
 * Step 4 is the one that matters. It is a value copy that happens after the
 * vector exists, which is exactly the ordering that makes the hash a genuine
 * fingerprint of embedded content rather than of "a file we noticed."
 *
 * Empirically, against the live index: 7 of 516 on-disk sources reproduced their
 * `last_read` hash exactly, and those 7 are the same 7 the staleness diagnosis
 * independently found fresh. Zero reproduced under LF normalization, which
 * proves the plugin hashes line endings as they sit on disk.
 *
 * ── The three ways it is wrong, and their directions ─────────────────────────
 *
 * Direction is the whole question. A false stale costs one embedding. A false
 * fresh is a confidently wrong answer.
 *
 *   - It hashes the WHOLE file, while the vector covers only the truncated embed
 *     input (~512 tokens). An edit past the truncation point moves the hash but
 *     not the vector. Direction: FALSE-STALE. Safe, and cheap.
 *   - It hashes line endings literally. `core.autocrlf` flipping CRLF to LF on
 *     another machine moves every hash in the vault. Direction: FALSE-STALE.
 *     Safe, expensive, and precisely why OUR OWN hash is canonical text instead.
 *     Reusing plugin vectors is a bonus; our own freshness never depends on it.
 *   - `charCodeAt(i) & 255` masks each UTF-16 unit to its low byte, so distinct
 *     non-ASCII characters can collide. Direction: FALSE-FRESH, and therefore
 *     the only one worth arithmetic. It is not the birthday problem: we never
 *     compare note X to note Y, only note X to its own previous version, so it
 *     is one pairwise comparison per note. At 2^-32 each over ~700 notes that is
 *     about 1.6e-7 for the entire vault. Accepted.
 *
 * ── The tightening ───────────────────────────────────────────────────────────
 *
 * `verifyPluginSource` requires all THREE recorded hashes to equal the recomputed
 * hash of current disk content, not just `last_embed`. `last_read` moves on every
 * read, and `last_import` moves on every import, while `last_embed` only moves
 * after a successful embed. If Obsidian read and imported a changed file and then
 * quit, was interrupted, or hit an embedding error before the queue drained, the
 * three disagree. Demanding all three costs nothing in the normal case, where
 * they are equal by construction, and closes that window in the safe direction.
 *
 * This module is used for ONE thing: deciding whether a vector the plugin already
 * paid for can be trusted. Every vector this server produces carries our own
 * canonical fingerprint instead. See `content-hash.ts`.
 */

import type { SmartSource } from './types.js';

function multiply32(a: number, b: number): number {
  return ((a & 0xffff) * b + (((a >>> 16) * b) << 16)) | 0;
}

function rotateLeft32(value: number, shift: number): number {
  return (value << shift) | (value >>> (32 - shift));
}

function fmix32(h: number): number {
  h ^= h >>> 16;
  h = multiply32(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = multiply32(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h;
}

/** murmur3-32. Transcribed from the plugin bundle; do not "improve" it. */
function murmurHash32(input: string, seed = 0): number {
  const remainder = input.length & 3;
  const bytes = input.length - remainder;
  let h1 = seed;
  const c1 = 0xcc9e2d51;
  const c2 = 0x1b873593;
  let i = 0;
  let k1 = 0;

  while (i < bytes) {
    k1 =
      (input.charCodeAt(i) & 0xff) |
      ((input.charCodeAt(i + 1) & 0xff) << 8) |
      ((input.charCodeAt(i + 2) & 0xff) << 16) |
      ((input.charCodeAt(i + 3) & 0xff) << 24);
    i += 4;
    k1 = multiply32(k1, c1);
    k1 = rotateLeft32(k1, 15);
    k1 = multiply32(k1, c2);
    h1 ^= k1;
    h1 = rotateLeft32(h1, 13);
    h1 = ((h1 * 5 + 0xe6546b64) | 0);
  }

  k1 = 0;
  switch (remainder) {
    case 3:
      k1 ^= (input.charCodeAt(i + 2) & 0xff) << 16;
    // falls through
    case 2:
      k1 ^= (input.charCodeAt(i + 1) & 0xff) << 8;
    // falls through
    case 1:
      k1 ^= input.charCodeAt(i) & 0xff;
      k1 = multiply32(k1, c1);
      k1 = rotateLeft32(k1, 15);
      k1 = multiply32(k1, c2);
      h1 ^= k1;
      break;
  }

  h1 ^= input.length;
  return fmix32(h1) | 0;
}

/**
 * The value Smart Connections stores. Takes the RAW file text, line endings and
 * BOM included, because that is what the plugin hashed.
 */
export function smartConnectionsHash(rawContent: string): string {
  return (murmurHash32(rawContent) >>> 0).toString(36);
}

export type PluginVectorVerdict =
  | 'verified-current'
  | 'content-changed'
  | 'embed-incomplete'
  | 'no-vector'
  | 'no-fingerprint';

/**
 * Can this plugin vector be ranked?
 *
 * `verified-current` is the ONLY verdict that permits use. Everything else is
 * stale, including the two "we cannot tell" verdicts, because not being able to
 * tell is the condition this build exists to stop treating as fine.
 */
export function verifyPluginSource(
  source: SmartSource | undefined,
  modelKey: string,
  rawContent: string
): PluginVectorVerdict {
  if (!source) return 'no-vector';

  const embedding = source.embeddings?.[modelKey];
  if (!embedding?.vec?.length) return 'no-vector';

  const embedHash = embedding.last_embed?.hash;
  const readHash = source.last_read?.hash;
  const importHash = source.last_import?.hash;
  if (!embedHash || !readHash || !importHash) return 'no-fingerprint';

  const current = smartConnectionsHash(rawContent);
  if (embedHash !== current) return 'content-changed';
  // Both of these equal `embedHash` in the ordinary case. When they do not,
  // the plugin saw the file again after embedding it and did not finish.
  if (readHash !== current || importHash !== current) return 'embed-incomplete';

  return 'verified-current';
}
