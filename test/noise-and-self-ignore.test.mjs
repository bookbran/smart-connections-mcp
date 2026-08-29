/**
 * Two honesty fixes, both measured on a real vault 2026-08-28.
 *
 * 1. The noise ceiling. Absolute similarity floors sit below the embedding
 *    model's baseline for unrelated text (pure gibberish scored 0.62-0.64 on
 *    bge-micro-v2, over the 0.4 default threshold), so a query about
 *    something ABSENT returns a confident-looking list and the empty-result
 *    machinery never fires — gibberish never produces an empty result. The
 *    ceiling is what fixed gibberish anchors score against THIS corpus;
 *    results at or below it are unrelated text wearing scores.
 *
 * 2. The self-ignoring cache dir. The supplemental cache is megabytes of
 *    vectors written INSIDE a vault that is very often a git repo, and no
 *    vault's own .gitignore can be assumed to cover it — found as an 8MB
 *    untracked file one `git add -A` from history.
 *
 * No embedding model loads here (the repo's standing rule): the ceiling math
 * runs on planted vectors, and the live wiring was verified against a real
 * vault with the real model before this landed.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { maxSimilarityAgainst } from '../dist/embedding-utils.js';
import { saveSupplementalCache } from '../dist/supplemental-store.js';
import { makeVault, fakeVec } from './helpers.mjs';

// -- the noise ceiling math ---------------------------------------------------

test('the ceiling is the best any anchor achieves, across the whole corpus', () => {
  const anchor = fakeVec(7);
  // One corpus vector IS the anchor (similarity 1), the rest are unrelated.
  const ceiling = maxSimilarityAgainst([anchor, fakeVec(8)], [fakeVec(50), anchor, fakeVec(51)]);
  assert.ok(ceiling !== null);
  assert.ok(Math.abs(ceiling - 1) < 1e-9, 'the max, never an average — one strong noise hit sets the bar');
});

test('a discriminating control: swapping which side holds the match flips nothing', () => {
  // The verifier must read substance, not position: a probe matching corpus
  // vector 3 scores the same however the lists are ordered.
  const probe = fakeVec(21);
  const corpus = [fakeVec(1), fakeVec(2), probe];
  const a = maxSimilarityAgainst([probe], corpus);
  const b = maxSimilarityAgainst([probe], corpus.slice().reverse());
  assert.strictEqual(a, b);
});

test('no probes, no corpus, or nothing comparable -> null, never 0', () => {
  // 0 is a similarity; "could not measure" must not impersonate one. Same rule
  // as unknown-vs-failed in the health report.
  assert.strictEqual(maxSimilarityAgainst([], [fakeVec(1)]), null);
  assert.strictEqual(maxSimilarityAgainst([fakeVec(1)], []), null);
  const short = fakeVec(1).slice(0, 10); // dimension mismatch is skipped, not thrown
  assert.strictEqual(maxSimilarityAgainst([short], [fakeVec(2)]), null);
});

test('unrelated planted vectors measure a real, sub-1 ceiling', () => {
  const ceiling = maxSimilarityAgainst(
    [fakeVec(101), fakeVec(102), fakeVec(103)],
    [fakeVec(1), fakeVec(2), fakeVec(3), fakeVec(4)]
  );
  assert.ok(ceiling !== null && ceiling < 1, 'random unit vectors are not identical');
  assert.ok(ceiling > -1, 'and cosine stays in range');
});

// -- the self-ignoring cache directory ---------------------------------------

const CACHE = { version: 1, algorithm: 'test', chunker: 1, entries: {} };

test('saving the supplemental cache leaves a .smart-env that ignores itself', () => {
  const v = makeVault();
  saveSupplementalCache(v.root, CACHE);
  const gi = join(v.root, '.smart-env', '.gitignore');
  assert.ok(existsSync(gi), 'the dir must carry its own ignore file');
  assert.strictEqual(readFileSync(gi, 'utf-8'), '*\n');
  assert.ok(existsSync(join(v.root, '.smart-env', 'mcp-supplemental.json')), 'and the cache still saves');
});

test("a member's own ignore file in .smart-env is never rewritten", () => {
  const v = makeVault();
  mkdirSync(join(v.root, '.smart-env'), { recursive: true });
  writeFileSync(join(v.root, '.smart-env', '.gitignore'), '# mine\nmcp-*.json\n', 'utf-8');
  saveSupplementalCache(v.root, CACHE);
  assert.strictEqual(
    readFileSync(join(v.root, '.smart-env', '.gitignore'), 'utf-8'),
    '# mine\nmcp-*.json\n'
  );
});
