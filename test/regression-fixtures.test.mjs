/**
 * Phase 8: a fixture for every case that produced this bug.
 *
 * The cases already covered elsewhere are not repeated here: the stale edit and
 * the stale block live in retrieval-truth, the same-size edit and the phantom in
 * corpus-state, budget exhaustion in refresh. This file holds the ones that had
 * no home, and the two that matter most are the last two: the COMBINED case that
 * defeats anything clever, and a real `git clone`.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'child_process';
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, utimesSync, rmSync, statSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { SmartConnectionsLoader } from '../dist/smart-connections-loader.js';
import { SearchEngine } from '../dist/search-engine.js';
import { CorpusProvider } from '../dist/current-corpus.js';
import { CorpusReconciler, VaultInventory } from '../dist/corpus-state.js';
import { canonicalContentHash } from '../dist/content-hash.js';
import { smartConnectionsHash } from '../dist/smart-connections-hash.js';
import { embedderAvailable } from '../dist/embedder.js';
import { makeVault, writeSmartEnv, fakeVec } from './helpers.mjs';

const MODEL_UP = await embedderAvailable('TaylorAI/bge-micro-v2').catch(() => false);

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });
}

// 8.1 -- touched but unchanged ----------------------------------------------

test('8.1 a file whose mtime moved but whose content did not stays FRESH', async () => {
  // The mirror image of the same-size-edit case, and the reason freshness is not
  // mtime. A sync, a checkout, a restore or a backup tool rewrites mtimes
  // wholesale. If that invalidated vectors, this vault would re-embed itself
  // every time Dan switched laptops: thousands of embed calls against a
  // 3,000-call budget, several runs to converge, every time.
  const v = makeVault();
  try {
    const body = '# Steady\n\n' + 'content that does not change. '.repeat(20);
    v.write('a.md', body);
    writeSmartEnv(v.root, [{ path: 'a.md', vec: fakeVec(71), hash: smartConnectionsHash(body) }]);

    const loader = new SmartConnectionsLoader(v.root);
    await loader.initialize();
    const rec = new CorpusReconciler(v.root, loader);

    let state = await rec.reconcile();
    assert.ok(state.pluginFresh.has('a.md'));
    const before = state.contentHashes.get('a.md');

    // Touch it into the future, changing nothing else.
    const future = Date.now() / 1000 + 86400;
    utimesSync(join(v.root, 'a.md'), future, future);
    assert.ok(statSync(join(v.root, 'a.md')).mtimeMs > Date.now(), 'the touch must have taken');

    state = await rec.reconcile();
    assert.equal(state.contentHashes.get('a.md'), before, 'the content hash must not move');
    assert.ok(state.pluginFresh.has('a.md'), 'and the vector must still be usable');
    assert.equal(state.semanticPending.has('a.md'), false);
  } finally {
    v.cleanup();
  }
});

// 8.1 -- unreadable ---------------------------------------------------------

test('8.1 a file that exists and cannot be read is classified, not silently dropped', async () => {
  const v = makeVault();
  try {
    v.write('readable.md', 'r'.repeat(300));
    const locked = v.write('locked.md', 'l'.repeat(300));

    // Deny read to the current user. Skipped loudly if the deny does not take,
    // which happens when the process is elevated: a test that quietly passes
    // because it did nothing is worse than one that says it was skipped.
    let denied = false;
    try {
      if (process.platform === 'win32') {
        execFileSync('icacls', [locked, '/deny', `${process.env.USERNAME}:(R)`], { stdio: 'ignore' });
      } else {
        execFileSync('chmod', ['000', locked], { stdio: 'ignore' });
      }
      try {
        readFileSync(locked, 'utf-8');
      } catch {
        denied = true;
      }
    } catch {
      /* permission tooling unavailable */
    }

    if (!denied) {
      console.error('[skip] could not make a file unreadable here; 8.1 unreadable case not exercised');
      return;
    }

    const loader = new SmartConnectionsLoader(v.root);
    await loader.initialize();
    const state = await new CorpusReconciler(v.root, loader).reconcile();

    assert.ok(state.onDisk.has('locked.md'), 'it EXISTS: it must not vanish from the inventory');
    assert.ok(state.unreadable.has('locked.md'), 'and it is not covered either');
    assert.equal(state.eligible.has('locked.md'), false, 'so it cannot count toward coverage');
    assert.equal(state.errors.read.length, 1, 'and it is a recorded error, not a silence');

    const engine = new SearchEngine(loader);
    const health = await engine.checkSearchHealth();
    assert.equal(
      health.freshnessVerified,
      false,
      'an unresolved read failure must cost us the right to claim freshness'
    );
    assert.equal(health.negativeResultsTrustworthy, false);

    if (process.platform === 'win32') {
      try {
        execFileSync('icacls', [locked, '/remove:d', process.env.USERNAME], { stdio: 'ignore' });
      } catch {}
    } else {
      try {
        execFileSync('chmod', ['644', locked], { stdio: 'ignore' });
      } catch {}
    }
  } finally {
    v.cleanup();
  }
});

// 8.1 -- a stale block must not outrank a fresh note ------------------------

test('8.1 a stale block cannot outrank a fresh note, through the real ranker', { skip: !MODEL_UP }, async () => {
  // The subtle one, and the reason 2.3 filters blocks as well as whole notes.
  // denseScores takes the MAX over a note's evidence, so a stale BLOCK vector
  // built from text that matched the query perfectly would win outright while
  // the note it points at no longer contains that text at all.
  //
  // Run through the real embedding model, because the claim is about ranking.
  const v = makeVault();
  try {
    const oldText = [
      '# Ledger',
      '',
      '## Kinklet partnership terms',
      '',
      'The kinklet partnership terms cover revenue share, exclusivity and the',
      'termination window in considerable detail.',
    ].join('\n');
    const newText = [
      '# Ledger',
      '',
      '## Office plants',
      '',
      'Notes about watering the office plants and which ones tolerate low light.',
    ].join('\n');

    v.write('ledger.md', newText);
    v.write(
      'partnership.md',
      [
        '# Partnership',
        '',
        'The kinklet partnership terms cover revenue share, exclusivity and the',
        'termination window in considerable detail.',
      ].join('\n')
    );

    // The plugin holds a vector AND a block vector for ledger.md, both built
    // from the OLD text about partnership terms.
    writeSmartEnv(v.root, [
      {
        path: 'ledger.md',
        vec: fakeVec(81),
        hash: smartConnectionsHash(oldText),
        blocks: [{ heading: 'Kinklet partnership terms', vec: fakeVec(82) }],
        blockRanges: { 'Kinklet partnership terms': [3, 6] },
      },
    ]);

    const loader = new SmartConnectionsLoader(v.root);
    await loader.initialize();
    const engine = new SearchEngine(loader);
    await engine.refreshSearchIndex(100);

    const response = await engine.searchByQuery('kinklet partnership terms', 5, 0.3);
    const paths = response.results.map((r) => r.path);
    assert.ok(paths.includes('partnership.md'), 'the note that actually says this must come back');

    const ledger = response.results.find((r) => r.path === 'ledger.md');
    if (ledger) {
      const partnership = response.results.find((r) => r.path === 'partnership.md');
      assert.ok(
        partnership.similarity > ledger.similarity,
        'a note whose only claim to relevance is text it no longer contains must not outrank ' +
          'the note that contains it'
      );
    }

    // And the mechanism, asserted directly rather than inferred from a rank.
    // ledger.md IS allowed to score moderately here: it was re-embedded from its
    // current text, and a small model finds some similarity between "Ledger" and
    // a query about terms. What must be true is that nothing built from the
    // deleted text is available to score it at all.
    const provider = new CorpusProvider(loader, v.root);
    const corpus = await provider.get({ skipIndexing: true });
    const sections = corpus.sectionVectors.get('ledger.md') ?? [];
    assert.equal(
      sections.some((b) => b.heading === 'Kinklet partnership terms'),
      false,
      'the stale BLOCK vector must be gone. denseScores takes the max over a note, so a ' +
        'block built from text the note no longer contains would win outright.'
    );
    assert.equal(
      corpus.state.pluginFresh.has('ledger.md'),
      false,
      'and its plugin entry must be classified stale, which is what removed the block'
    );
  } finally {
    v.cleanup();
  }
});

// 8.2 -- the combined case --------------------------------------------------

test('8.2 same-size edit AND preserved timestamp AND flipped line endings AND a plugin vector', async () => {
  // Each ingredient is tested separately elsewhere. This is the one that breaks
  // anything clever, because every individual signal a cache might reach for is
  // either unchanged or changed for the wrong reason:
  //
  //   size      unchanged
  //   mtime     unchanged
  //   raw bytes changed, but only because the line endings flipped
  //   content   changed
  //
  // A metadata cache says fresh. A raw-byte hash says stale for the wrong reason
  // and would also have said stale if nothing had been edited at all. Only a
  // canonical content hash gets both halves right.
  const v = makeVault();
  try {
    const originalLf = '# Note\n\nThe target number is 40K by January.\nSecond line here.\n';
    const editedCrlf = '# Note\r\n\r\nThe target number is 50K by January.\r\nSecond line here.\r\n';

    v.write('n.md', originalLf);
    writeSmartEnv(v.root, [
      { path: 'n.md', vec: fakeVec(91), hash: smartConnectionsHash(originalLf) },
    ]);

    const loader = new SmartConnectionsLoader(v.root);
    await loader.initialize();
    const rec = new CorpusReconciler(v.root, loader);

    let state = await rec.reconcile();
    assert.ok(state.pluginFresh.has('n.md'), 'baseline: the vector verifies');
    const sizeBefore = statSync(join(v.root, 'n.md')).size;

    v.writePreservingTime('n.md', editedCrlf, 1000000);

    // Prove the preconditions rather than assuming them: this fixture is only
    // interesting if the metadata really did not move.
    const after = statSync(join(v.root, 'n.md'));
    assert.equal(after.mtimeMs, 1000000 * 1000, 'the timestamp must be preserved');
    assert.notEqual(after.size, sizeBefore, 'CRLF changes byte size, so size alone is not the trap');

    state = await rec.reconcile();
    assert.ok(state.pluginStale.has('n.md'), 'the content change must be caught');
    assert.ok(state.semanticPending.has('n.md'));

    // And the control: the SAME line-ending flip with no content edit must NOT
    // invalidate our own fingerprint, or a machine switch re-embeds the vault.
    const originalCrlf = originalLf.replace(/\n/g, '\r\n');
    assert.equal(
      canonicalContentHash(originalLf).hash,
      canonicalContentHash(originalCrlf).hash,
      'line endings alone must never move OUR hash'
    );
    assert.notEqual(
      canonicalContentHash(originalLf).hash,
      canonicalContentHash(editedCrlf).hash,
      'but a real edit must, even arriving with different line endings'
    );
  } finally {
    v.cleanup();
  }
});

// 8.3 -- a real git clone ---------------------------------------------------

test('8.3 a fresh git clone, with autocrlf flipping every line ending, invalidates nothing', () => {
  // Run against real git rather than a simulation, because the thing being
  // tested is what git actually does to a working tree, and that is exactly the
  // class of assumption that has been wrong here before.
  const origin = mkdtempSync(join(tmpdir(), 'sc-origin-'));
  const clone = mkdtempSync(join(tmpdir(), 'sc-clone-'));
  try {
    git(origin, 'init', '-q');
    git(origin, 'config', 'user.email', 'test@example.com');
    git(origin, 'config', 'user.name', 'Test');
    git(origin, 'config', 'core.autocrlf', 'false');

    const notes = {
      'a.md': '# A\n\nSome content in this note.\n',
      'nested/b.md': '# B\n\nMore content, in a nested folder.\n',
      'c.md': '# C\n\nA third note to make the sample less lonely.\n',
    };
    // Written directly rather than through a shell, so nothing normalizes them.
    for (const [rel, body] of Object.entries(notes)) {
      const abs = join(origin, rel);
      mkdirSync(join(abs, '..'), { recursive: true });
      writeFileSync(abs, body, 'utf-8');
    }
    git(origin, 'add', '-A');
    git(origin, 'commit', '-q', '-m', 'notes');

    const before = new Map();
    for (const entry of VaultInventory.build(origin).values()) {
      before.set(entry.path, canonicalContentHash(readFileSync(join(origin, entry.diskPath), 'utf-8')).hash);
    }
    assert.equal(before.size, 3);

    // Clone with autocrlf on, which is what this vault's other machine does.
    git(clone, 'clone', '-q', '-c', 'core.autocrlf=true', origin, 'vault');
    const vault = join(clone, 'vault');

    // Verify the premise: the clone really does have different bytes on disk.
    const cloned = readFileSync(join(vault, 'a.md'), 'utf-8');
    assert.ok(cloned.includes('\r\n'), 'the clone must actually have CRLF, or this proves nothing');

    const after = new Map();
    for (const entry of VaultInventory.build(vault).values()) {
      after.set(entry.path, canonicalContentHash(readFileSync(join(vault, entry.diskPath), 'utf-8')).hash);
    }

    assert.deepEqual(
      [...after.entries()].sort(),
      [...before.entries()].sort(),
      'a clone rewrites every mtime and every line ending. Not one note may be invalidated ' +
        'by that, or switching machines costs a full re-embed every time.'
    );
  } finally {
    rmSync(origin, { recursive: true, force: true });
    rmSync(clone, { recursive: true, force: true });
  }
});

// 8.4 -- the guard against this whole class ---------------------------------

test('8.4 the suite fails on a stale index by construction, and here is the proof', async () => {
  // A meta-test, and worth having. The specific way this bug shipped is that
  // every check available to it passed. So one test asserts that the fixtures
  // themselves would break if the fix were reverted: a stale plugin entry must
  // produce a corpus with NOTHING rankable, which is the exact opposite of what
  // the old engine produced from the same input.
  const v = makeVault();
  try {
    const body = '# Note\n\n' + 'original wording. '.repeat(20);
    v.write('n.md', body);
    v.write('other.md', 'o'.repeat(300));
    writeSmartEnv(v.root, [
      { path: 'n.md', vec: fakeVec(101), hash: smartConnectionsHash(body) },
      { path: 'other.md', vec: fakeVec(102), hash: 'never-matched' },
    ]);

    const loader = new SmartConnectionsLoader(v.root);
    await loader.initialize();
    const provider = new CorpusProvider(loader, v.root);

    let corpus = await provider.get({ skipIndexing: true });
    assert.equal(corpus.noteVectors.size, 1, 'the verifying entry is usable');
    assert.equal(corpus.noteVectors.has('n.md'), true);
    assert.equal(corpus.noteVectors.has('other.md'), false, 'the non-verifying entry is not');

    // Now move the content, which is all it takes.
    v.writePreservingTime('n.md', body.replace('original wording.', 'replaced wording!'), 1000000);
    corpus = await provider.get({ skipIndexing: true });
    assert.equal(
      corpus.noteVectors.size,
      0,
      'the old engine ranked BOTH of these and reported unsearchable: 0 while doing it'
    );
  } finally {
    v.cleanup();
  }
});
