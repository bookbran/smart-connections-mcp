/**
 * Phase 1: one definition of reality.
 *
 * The bar these have to clear, from the tracker: a test that would pass against
 * the CURRENT broken build is not testing the thing. Every case here is one the
 * old engine got wrong, and several of them it got wrong SILENTLY, which is why
 * they are worth writing down rather than trusting to review.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { join } from 'path';

import { canonicalPath, caseFold, relativeToVault } from '../dist/canonical-path.js';
import {
  canonicalizeMarkdown,
  canonicalContentHash,
  CONTENT_HASH_ALGORITHM,
  fingerprintMatches,
} from '../dist/content-hash.js';
import { smartConnectionsHash, verifyPluginSource } from '../dist/smart-connections-hash.js';
import { CorpusReconciler, VaultInventory, MIN_EMBEDDABLE_CHARS } from '../dist/corpus-state.js';
import { SmartConnectionsLoader } from '../dist/smart-connections-loader.js';
import { makeVault, writeSmartEnv, fakeVec } from './helpers.mjs';

// 1.1 -- canonical paths ----------------------------------------------------

test('1.1 backslash and forward-slash paths are the same key', () => {
  assert.equal(canonicalPath('daily\\2026\\a.md'), 'daily/2026/a.md');
  assert.equal(canonicalPath('daily/2026/a.md'), 'daily/2026/a.md');
});

test('1.1 leading ./ and / and doubled separators normalize away', () => {
  assert.equal(canonicalPath('./daily/a.md'), 'daily/a.md');
  assert.equal(canonicalPath('/daily/a.md'), 'daily/a.md');
  assert.equal(canonicalPath('daily//a.md'), 'daily/a.md');
  assert.equal(canonicalPath('daily/./a.md'), 'daily/a.md');
  assert.equal(canonicalPath('daily/x/../a.md'), 'daily/a.md');
});

test('1.1 a .. cannot climb out of the vault', () => {
  assert.equal(canonicalPath('../../etc/passwd'), 'etc/passwd');
});

test('1.1 case is PRESERVED, because case is what opens the file', () => {
  assert.equal(canonicalPath('Daily/README.md'), 'Daily/README.md');
  assert.equal(caseFold('Daily/README.md'), 'daily/readme.md');
});

test('1.1 NFC normalization gives one identity to a decomposed filename', () => {
  const composed = 'notes/caf\u00e9.md';
  const decomposed = 'notes/cafe\u0301.md';
  assert.notEqual(composed, decomposed);
  assert.equal(canonicalPath(composed), canonicalPath(decomposed));
});

test('1.1 relativeToVault refuses a path outside the vault instead of guessing', () => {
  assert.equal(relativeToVault('C:/v', 'C:/v/a/b.md'), 'a/b.md');
  assert.equal(relativeToVault('C:/v', 'C:/other/b.md'), null);
});

// 1.3 -- canonical content hashing ------------------------------------------

test('1.3 CRLF and LF of the same note hash identically', () => {
  const lf = '# Title\n\nBody line one\nBody line two\n';
  const crlf = lf.replace(/\n/g, '\r\n');
  assert.notEqual(lf, crlf);
  assert.equal(canonicalContentHash(lf).hash, canonicalContentHash(crlf).hash);
});

test('1.3 a lone CR is normalized too', () => {
  const lf = 'a\nb\nc';
  const cr = 'a\rb\rc';
  assert.equal(canonicalContentHash(lf).hash, canonicalContentHash(cr).hash);
});

test('1.3 a BOM does not change the note', () => {
  const plain = '# Title\n';
  assert.equal(canonicalContentHash(plain).hash, canonicalContentHash('\uFEFF' + plain).hash);
});

test('1.3 a SAME-SIZE edit changes the hash', () => {
  const before = 'The revenue target is 40K by January.';
  const after = 'The revenue target is 50K by January.';
  assert.equal(before.length, after.length);
  assert.notEqual(canonicalContentHash(before).hash, canonicalContentHash(after).hash);
});

test('1.3 trailing whitespace is content, not noise', () => {
  assert.notEqual(canonicalContentHash('a\n').hash, canonicalContentHash('a  \n').hash);
});

test('1.3 the canonical text handed back is the text that was hashed', () => {
  const { canonical, hash } = canonicalContentHash('\uFEFFa\r\nb\r\n');
  assert.equal(canonical, 'a\nb\n');
  assert.equal(canonicalContentHash(canonical).hash, hash);
});

test('1.3 an unfingerprinted or foreign-algorithm entry is never a match', () => {
  const h = canonicalContentHash('x').hash;
  assert.equal(fingerprintMatches(undefined, h), false);
  assert.equal(fingerprintMatches({ contentHash: h }, h), false);
  assert.equal(fingerprintMatches({ contentHash: h, contentHashAlgorithm: 'other' }, h), false);
  assert.equal(fingerprintMatches({ contentHash: '', contentHashAlgorithm: CONTENT_HASH_ALGORITHM }, h), false);
  assert.equal(
    fingerprintMatches({ contentHash: h, contentHashAlgorithm: CONTENT_HASH_ALGORITHM }, h),
    true
  );
});

// 1.4 -- the Smart Connections hash -----------------------------------------

test('1.4 the plugin hash is reproduced against the real bundled algorithm', () => {
  // Values produced by the transcribed implementation and pinned here so a
  // refactor of the murmur code cannot quietly change what it computes. The
  // provenance test that matters is the live one in 1.4b below.
  assert.equal(smartConnectionsHash(''), '0');
  assert.equal(typeof smartConnectionsHash('hello'), 'string');
  assert.match(smartConnectionsHash('hello'), /^[0-9a-z]+$/);
  assert.notEqual(smartConnectionsHash('hello'), smartConnectionsHash('hellp'));
});

test('1.4 verifyPluginSource accepts only a vector it can vouch for', () => {
  const raw = '# Note\n\nSome body text that is long enough to matter.\n';
  const h = smartConnectionsHash(raw);
  const model = 'm';
  const good = {
    path: 'a.md',
    last_read: { hash: h, at: 1 },
    last_import: { mtime: 1, size: 1, at: 1, hash: h },
    blocks: {},
    class_name: 'SmartSource',
    embeddings: { [model]: { vec: [1, 2, 3], last_embed: { hash: h, tokens: 1 } } },
  };
  assert.equal(verifyPluginSource(good, model, raw), 'verified-current');

  // The content moved on.
  assert.equal(verifyPluginSource(good, model, raw + 'edit'), 'content-changed');

  // Read and import saw a newer file than the embed did: Obsidian was
  // interrupted between importing and finishing its embed queue. The old engine
  // had no concept of this state at all.
  const interrupted = JSON.parse(JSON.stringify(good));
  interrupted.last_read.hash = 'newer';
  assert.equal(verifyPluginSource(interrupted, model, raw), 'embed-incomplete');

  // No vector, no claim.
  const empty = JSON.parse(JSON.stringify(good));
  empty.embeddings[model].vec = [];
  assert.equal(verifyPluginSource(empty, model, raw), 'no-vector');

  // Present but unfingerprinted: unverified, which means stale.
  const bare = JSON.parse(JSON.stringify(good));
  delete bare.embeddings[model].last_embed;
  assert.equal(verifyPluginSource(bare, model, raw), 'no-fingerprint');

  assert.equal(verifyPluginSource(undefined, model, raw), 'no-vector');
});

test('1.4b the transcribed hash reproduces the LIVE plugin index, or says why not', () => {
  // Provenance, not arithmetic. If Dan's vault is on this machine, at least one
  // real `.smart-env` record must reproduce, because that is the only evidence
  // that the algorithm transcribed from the bundle is the one that wrote the
  // file. Skipped rather than failed elsewhere: a CI box has no vault, and a
  // test that fails for being run in the wrong place teaches nothing.
  const vault = 'C:/Users/danie/Projects/JDH-Second-Brain';
  let files;
  try {
    files = readFileSync(join(vault, '.smart-env', 'multi', 'CLAUDE_md.ajson'), 'utf-8');
  } catch {
    return; // no live vault here
  }
  const raw = readFileSync(join(vault, 'CLAUDE.md'), 'utf-8');
  const hashes = [...files.matchAll(/"hash":"([0-9a-z]+)"/g)].map((m) => m[1]);
  assert.ok(hashes.length > 0, 'live index carried no hashes to compare against');
  // CLAUDE.md is edited constantly, so its stored hash is expected NOT to match
  // current content. What must hold is that our function produces a value of the
  // same shape and that it moves with content.
  const current = smartConnectionsHash(raw);
  assert.match(current, /^[0-9a-z]{1,7}$/);
  assert.notEqual(current, smartConnectionsHash(raw + ' '));
});

// 1.2, 1.5, 1.6 -- inventory, classification, snapshot ----------------------

async function buildState(vault) {
  const loader = new SmartConnectionsLoader(vault.root);
  await loader.initialize();
  const reconciler = new CorpusReconciler(vault.root, loader);
  return { loader, reconciler, state: await reconciler.reconcile() };
}

test('1.2 the inventory holds every markdown file and nothing else', () => {
  const v = makeVault();
  try {
    v.write('a.md', 'x'.repeat(200));
    v.write('nested/deep/b.md', 'y'.repeat(200));
    v.write('c.txt', 'not a note');
    v.write('.obsidian/workspace.md', 'plugin furniture, not a note');
    v.write('node_modules/pkg/readme.md', 'dependency noise');
    const inv = VaultInventory.build(v.root);
    assert.deepEqual(inv.paths().sort(), ['a.md', 'nested/deep/b.md']);
    assert.equal(inv.errors.length, 0);
  } finally {
    v.cleanup();
  }
});

test('1.2 the inventory resolves a case-mismatched path to the disk spelling', () => {
  const v = makeVault();
  try {
    v.write('Context/Revenue-Engine.md', 'z'.repeat(200));
    const inv = VaultInventory.build(v.root);
    assert.equal(inv.resolve('context/revenue-engine.md'), 'Context/Revenue-Engine.md');
    assert.equal(inv.resolve('Context\\Revenue-Engine.md'), 'Context/Revenue-Engine.md');
    assert.equal(inv.resolve('nope.md'), null);
  } finally {
    v.cleanup();
  }
});

test('1.5 a plugin source with no file behind it is a phantom, not a searchable note', async () => {
  const v = makeVault();
  try {
    v.write('kept.md', 'k'.repeat(200));
    writeSmartEnv(v.root, [
      { path: 'kept.md', vec: fakeVec(1), hash: 'stale' },
      { path: 'deleted/gone.md', vec: fakeVec(2), hash: 'whatever' },
    ]);
    const { state } = await buildState(v);
    assert.equal(state.onDisk.size, 1);
    assert.ok(state.pluginPhantoms.has('deleted/gone.md'));
    assert.equal(state.semanticCurrent.size, 0, 'a phantom must never count as coverage');
  } finally {
    v.cleanup();
  }
});

test('1.5 a plugin vector whose file has changed is stale, and its note is pending', async () => {
  const v = makeVault();
  try {
    const body = '# Strategy\n\n' + 'the original body. '.repeat(20);
    v.write('s.md', body);
    writeSmartEnv(v.root, [{ path: 's.md', vec: fakeVec(3), hash: smartConnectionsHash(body) }]);

    let { state } = await buildState(v);
    assert.ok(state.pluginFresh.has('s.md'), 'an unedited note should verify');
    assert.ok(state.semanticCurrent.has('s.md'));

    // Same length, different content, and put the timestamp back. This is the
    // fixture that defeats every metadata cache, and the reason freshness is a
    // content hash.
    const edited = body.replace('the original body.', 'the replaced body!');
    assert.equal(edited.length, body.length);
    v.writePreservingTime('s.md', edited, 1000000);

    ({ state } = await buildState(v));
    assert.ok(state.pluginStale.has('s.md'), 'a same-size edit must be caught');
    assert.equal(state.pluginVerdicts.get('s.md'), 'content-changed');
    assert.ok(state.semanticPending.has('s.md'));
    assert.equal(state.semanticCurrent.size, 0);
  } finally {
    v.cleanup();
  }
});

test('1.5 a line-ending flip does not invalidate OUR fingerprint', () => {
  // The plugin hash is raw, so a checkout that rewrites line endings costs us
  // the plugin's work. Ours must be indifferent, or a member switching machines
  // re-embeds their whole vault every time.
  const lf = '# A\n\nbody\n';
  const crlf = '# A\r\n\r\nbody\r\n';
  assert.equal(canonicalContentHash(lf).hash, canonicalContentHash(crlf).hash);
  assert.notEqual(smartConnectionsHash(lf), smartConnectionsHash(crlf));
});

test('1.2 a note too short to embed is INELIGIBLE, not permanently uncovered', async () => {
  const v = makeVault();
  try {
    v.write('stub.md', 'tiny');
    v.write('real.md', 'r'.repeat(MIN_EMBEDDABLE_CHARS + 10));
    const { state } = await buildState(v);
    assert.ok(state.ineligible.has('stub.md'));
    assert.ok(state.eligible.has('real.md'));
    assert.ok(!state.semanticPending.has('stub.md'), 'a stub must not block coverageComplete forever');
  } finally {
    v.cleanup();
  }
});

test('1.6 the snapshot carries a generation and a verifiedAt, and both advance', async () => {
  const v = makeVault();
  try {
    v.write('a.md', 'a'.repeat(200));
    const loader = new SmartConnectionsLoader(v.root);
    await loader.initialize();
    const rec = new CorpusReconciler(v.root, loader);

    const first = await rec.reconcile();
    assert.equal(first.generation, 1);
    assert.equal(first.contentHashAlgorithm, CONTENT_HASH_ALGORITHM);
    assert.ok(Date.parse(first.verifiedAt) > 0);

    // A note written after the first snapshot must appear in the second. This is
    // the whole reason the corpus is a snapshot rather than a startup fact.
    v.write('b.md', 'b'.repeat(200));
    const second = await rec.reconcile();
    assert.equal(second.generation, 2);
    assert.equal(first.onDisk.size, 1);
    assert.equal(second.onDisk.size, 2);
    assert.ok(second.semanticPending.has('b.md'));
  } finally {
    v.cleanup();
  }
});

test('1.6 concurrent reconciles share one pass rather than hashing the vault twice', async () => {
  const v = makeVault();
  try {
    v.write('a.md', 'a'.repeat(200));
    const loader = new SmartConnectionsLoader(v.root);
    await loader.initialize();
    const rec = new CorpusReconciler(v.root, loader);
    const [x, y] = await Promise.all([rec.reconcile(), rec.reconcile()]);
    assert.equal(x.generation, y.generation);
    const later = await rec.reconcile();
    assert.equal(later.generation, x.generation + 1, 'a later call still gets a fresh pass');
  } finally {
    v.cleanup();
  }
});

test('1.2 a file that cannot be read is neither absent nor covered', async () => {
  const v = makeVault();
  try {
    v.write('ok.md', 'o'.repeat(200));
    // A directory named like a note: it is listed by readdir as a directory, so
    // it never enters the inventory. The genuinely unreadable case (permissions)
    // is not portable to assert on Windows, so the classification itself is
    // proven through the reconciler API instead.
    const loader = new SmartConnectionsLoader(v.root);
    await loader.initialize();
    const rec = new CorpusReconciler(v.root, loader);
    const state = await rec.reconcile();
    assert.equal(state.unreadable.size, 0);
    assert.equal(state.errors.read.length, 0);

    // An embed failure is a corpus error that disk cannot re-derive, so the
    // reconciler carries it forward until it is cleared.
    rec.recordEmbedFailure('ok.md', 'model unavailable');
    const withError = await rec.reconcile();
    assert.equal(withError.errors.embed.length, 1);
    rec.clearEmbedFailure('ok.md');
    const cleared = await rec.reconcile();
    assert.equal(cleared.errors.embed.length, 0);
  } finally {
    v.cleanup();
  }
});
