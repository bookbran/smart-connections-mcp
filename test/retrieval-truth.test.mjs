/**
 * Phases 2, 3, 4, 5, 6: retrieval tells the truth.
 *
 * The standard, from the tracker: every retrieval-semantics test must FAIL on a
 * stale index by construction. A test that would pass against the broken build
 * is not testing the thing. So each of these plants a stale plugin vector for a
 * note whose text has moved on, and asserts on the behaviour that used to be
 * wrong.
 *
 * No embedding model is loaded here. These run against planted vectors, which is
 * deliberate: the questions being asked are about which vectors get RANKED and
 * what gets REPORTED, and involving a real model would make them slow, network
 * dependent, and about something else.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { SmartConnectionsLoader } from '../dist/smart-connections-loader.js';
import { CorpusProvider } from '../dist/current-corpus.js';
import { SearchEngine } from '../dist/search-engine.js';
import { makeVault, writeSmartEnv, fakeVec, smartConnectionsHash } from './helpers.mjs';

const MODEL = 'TaylorAI/bge-micro-v2';

async function corpusFor(vault, options = { skipIndexing: true }) {
  const loader = new SmartConnectionsLoader(vault.root);
  await loader.initialize();
  const provider = new CorpusProvider(loader, vault.root);
  return { loader, provider, corpus: await provider.get(options) };
}

/**
 * A vault holding one note whose plugin vector was built from OLD text.
 *
 * This is the shape of the real bug: the plugin has an entry for the path, the
 * file on disk says something else now, and every count derived from the index
 * agrees with itself.
 */
function staleVault() {
  const v = makeVault();
  const original = [
    '# Revenue engine',
    '',
    'The original text talked about coach capacity being the constraint.',
    'It said a great deal about hiring more coaches.',
  ].join('\n');
  const edited = [
    '# Revenue engine',
    '',
    'Demand generation is the binding constraint, not coach capacity.',
    'The distinctive phrase here is zamboni-calibration-protocol.',
  ].join('\n');

  v.write('context/revenue-engine.md', edited);
  v.write('context/unrelated.md', '# Unrelated\n\n' + 'filler content. '.repeat(20));
  writeSmartEnv(v.root, [
    {
      // Hash of the ORIGINAL text, while the file now holds the edited text.
      path: 'context/revenue-engine.md',
      vec: fakeVec(11),
      hash: smartConnectionsHash(original),
      blocks: [{ heading: 'Revenue engine', vec: fakeVec(12) }],
      blockRanges: { 'Revenue engine': [1, 4] },
    },
  ]);
  return v;
}

// 2.1, 2.3 -- stale vectors leave the ranking -------------------------------

test('2.3 a stale plugin vector is dropped from the corpus, whole-note AND block', async () => {
  const v = staleVault();
  try {
    const { corpus } = await corpusFor(v);
    assert.ok(corpus.state.pluginStale.has('context/revenue-engine.md'));
    assert.equal(
      corpus.noteVectors.has('context/revenue-engine.md'),
      false,
      'the stale whole-note vector must not be rankable'
    );
    assert.equal(
      corpus.sectionVectors.has('context/revenue-engine.md'),
      false,
      'the stale BLOCK vector must go too: denseScores takes the max, so a stale block ' +
        'can be the strongest signal for a note and filtering only one of the two leaves ' +
        'the bug fully intact'
    );
  } finally {
    v.cleanup();
  }
});

test('2.1 supplemental indexing consumes semanticPending, not "missing from plugin"', async () => {
  const v = staleVault();
  try {
    const { corpus } = await corpusFor(v);
    // The old predicate was `!knownPaths.has(p)`, and the plugin HAS this path,
    // so the old engine skipped it forever and kept ranking June's vector.
    assert.ok(
      corpus.state.semanticPending.has('context/revenue-engine.md'),
      'a note the plugin knows about but has not re-embedded must still be pending'
    );
  } finally {
    v.cleanup();
  }
});

test('2.2 a vector is bound to the exact content that produced it', async () => {
  const v = makeVault();
  try {
    const body = '# Note\n\n' + 'stable content here. '.repeat(20);
    v.write('a.md', body);
    const { provider } = await corpusFor(v);

    // Plant a supplemental entry whose fingerprint matches the current file, and
    // one whose fingerprint does not. Only the first may be ranked.
    const { loadSupplementalCache, saveSupplementalCache, CHUNKER_VERSION } = await import(
      '../dist/supplemental-store.js'
    );
    const { canonicalContentHash, CONTENT_HASH_ALGORITHM } = await import('../dist/content-hash.js');
    const cache = loadSupplementalCache(v.root);
    cache.entries['a.md'] = {
      vec: fakeVec(21),
      sections: [fakeVec(22)],
      chunker: CHUNKER_VERSION,
      contentHash: canonicalContentHash(body).hash,
      contentHashAlgorithm: CONTENT_HASH_ALGORITHM,
      embeddedAt: 1,
    };
    saveSupplementalCache(v.root, cache);

    let corpus = await provider.get({ skipIndexing: true });
    assert.ok(corpus.noteVectors.has('a.md'), 'a matching fingerprint is rankable');

    // Now edit the file to the SAME LENGTH and put the timestamp back. Nothing
    // about size or mtime changed. The fingerprint did.
    const edited = body.replace('stable content here.', 'stable content HERE!');
    assert.equal(edited.length, body.length);
    v.writePreservingTime('a.md', edited, 1000000);

    corpus = await provider.get({ skipIndexing: true });
    assert.equal(
      corpus.noteVectors.has('a.md'),
      false,
      'a same-size edit with a preserved timestamp must invalidate the vector'
    );
  } finally {
    v.cleanup();
  }
});

// 3.1 -- the lexical corpus is the whole vault ------------------------------

test('3.1 keyword search finds a note the plugin has never seen', async () => {
  const v = staleVault();
  try {
    v.write('daily/today.md', '# Today\n\nA note written just now about quokka-fitted-sheet.');
    const { loader, corpus } = await corpusFor(v);
    const engine = new SearchEngine(loader);
    const hits = engine.searchByKeyword('quokka-fitted-sheet', corpus, 10, 0);
    assert.ok(
      hits.some((h) => h.path === 'daily/today.md'),
      'a note on disk that no index has ever seen must still be findable by its own words'
    );
  } finally {
    v.cleanup();
  }
});

test('2.4 the lexical rescue comes back for a note with a stale vector', async () => {
  // The sharpest single proof the fix worked. Reproduced on the real vault: a
  // stale note ranked 6th of 55 in the keyword scorer for a literal phrase and
  // never appeared in fused output, because its stale vector earned a bad dense
  // rank and RRF buried a lexical-only hit under notes scoring in both lists.
  // With the stale vector gone, the note is lexical-only and rises.
  const v = staleVault();
  try {
    const { loader, corpus } = await corpusFor(v);
    const engine = new SearchEngine(loader);
    const hits = engine.searchByKeyword('zamboni-calibration-protocol', corpus, 10, 0);
    assert.ok(
      hits.some((h) => h.path === 'context/revenue-engine.md'),
      'the edited note must be findable by a phrase that exists only in its NEW text'
    );
    // And the old text must NOT be what answers.
    const oldHits = engine.searchByKeyword('hiring more coaches', corpus, 10, 0.5);
    assert.equal(
      oldHits.some((h) => h.path === 'context/revenue-engine.md'),
      false,
      'the deleted text must not still be findable'
    );
  } finally {
    v.cleanup();
  }
});

// 4.1, 4.2 -- coverage by set difference ------------------------------------

test('4.1 coverage counts the vault, not the index, and never reports a false zero', async () => {
  const v = staleVault();
  try {
    v.write('daily/today.md', '# Today\n\n' + 'unindexed content. '.repeat(20));
    const { loader } = await corpusFor(v);
    const engine = new SearchEngine(loader);
    const stats = await engine.getStats();

    assert.equal(stats.vaultNotes, 3, 'three notes on disk');
    assert.equal(stats.pluginSources, 1, 'one plugin source');
    assert.equal(stats.pluginFresh, 0, 'and it is stale');
    assert.equal(stats.semanticSearchable, 0);
    assert.equal(
      stats.semanticPending,
      3,
      'the old engine reported unsearchable: 0 in exactly this situation, because both ' +
        'sides of that subtraction came from the same two indexes'
    );
  } finally {
    v.cleanup();
  }
});

test('4.2 a phantom cannot inflate any count', async () => {
  const v = makeVault();
  try {
    v.write('kept.md', 'k'.repeat(300));
    writeSmartEnv(v.root, [
      { path: 'kept.md', vec: fakeVec(31), hash: 'stale' },
      { path: 'deleted.md', vec: fakeVec(32), hash: 'stale' },
      { path: 'also-deleted.md', vec: fakeVec(33), hash: 'stale' },
    ]);
    const { loader, corpus } = await corpusFor(v);
    const engine = new SearchEngine(loader);
    const stats = await engine.getStats();
    assert.equal(stats.vaultNotes, 1);
    assert.equal(stats.pluginSources, 3);
    assert.equal(corpus.state.pluginPhantoms.size, 2);
    assert.equal(stats.semanticSearchable, 0);
    assert.ok(stats.semanticPending <= stats.vaultNotes, 'pending can never exceed the vault');
  } finally {
    v.cleanup();
  }
});

test('4.2 any unresolved corpus error prevents freshnessVerified from being true', async () => {
  const { corpusIsClean } = await import('../dist/corpus-state.js');
  const v = makeVault();
  try {
    v.write('a.md', 'a'.repeat(300));
    const loader = new SmartConnectionsLoader(v.root);
    await loader.initialize();
    const engine = new SearchEngine(loader);

    const health = await engine.checkSearchHealth();
    assert.equal(health.freshnessVerified, true, 'a clean vault verifies');
    assert.equal(health.coverage.errors.inventory, 0);
    assert.equal(health.coverage.errors.read, 0);

    // The predicate itself, exercised over each error class in turn. Same
    // philosophy as not letting the health check grade its own homework: an
    // error we could not resolve must cost us the right to claim freshness,
    // whichever stage it happened at.
    const base = {
      errors: { inventory: [], read: [], hash: [], embed: [] },
    };
    assert.equal(corpusIsClean(base), true);
    for (const scope of ['inventory', 'read', 'hash', 'embed']) {
      const dirty = { errors: { inventory: [], read: [], hash: [], embed: [] } };
      dirty.errors[scope] = [{ scope, message: 'something went wrong' }];
      assert.equal(corpusIsClean(dirty), false, `an unresolved ${scope} error must block freshness`);
    }
  } finally {
    v.cleanup();
  }
});

// 5.x -- every other retrieval surface --------------------------------------

test('5.1 get_similar_notes refuses to answer from a stale vector', async () => {
  const v = staleVault();
  try {
    const { loader } = await corpusFor(v);
    const engine = new SearchEngine(loader);
    await assert.rejects(
      () => engine.getSimilarNotes('context/revenue-engine.md'),
      (err) => {
        // The old engine happily returned neighbours computed from June's text.
        assert.match(err.message, /verified-current|No embeddings/);
        return true;
      }
    );
  } finally {
    v.cleanup();
  }
});

test('5.2 the QUERY note uses OUR vector when the plugin has only a stale one', async () => {
  const v = staleVault();
  try {
    const { provider } = await corpusFor(v);
    const { loadSupplementalCache, saveSupplementalCache, CHUNKER_VERSION } = await import(
      '../dist/supplemental-store.js'
    );
    const { canonicalContentHash, CONTENT_HASH_ALGORITHM } = await import('../dist/content-hash.js');
    const { readFileSync } = await import('fs');
    const { join } = await import('path');

    const cache = loadSupplementalCache(v.root);
    for (const rel of ['context/revenue-engine.md', 'context/unrelated.md']) {
      const raw = readFileSync(join(v.root, rel), 'utf-8');
      cache.entries[rel] = {
        vec: fakeVec(rel.length + 40),
        sections: [],
        chunker: CHUNKER_VERSION,
        contentHash: canonicalContentHash(raw).hash,
        contentHashAlgorithm: CONTENT_HASH_ALGORITHM,
        embeddedAt: 1,
      };
    }
    saveSupplementalCache(v.root, cache);

    const corpus = await provider.get({ skipIndexing: true });
    const vec = corpus.noteVectors.get('context/revenue-engine.md');
    assert.ok(vec, 'the supplemental vector must be the one available');
    assert.deepEqual(
      vec,
      cache.entries['context/revenue-engine.md'].vec,
      'the query note must be answered from the supplemental vector, not the stale plugin one. ' +
        'Easy to miss, because the source note is fetched by a different call path than the ' +
        'comparison set.'
    );
  } finally {
    v.cleanup();
  }
});

test('5.3 the connection graph inherits the fix rather than being assumed to', async () => {
  const v = staleVault();
  try {
    const { loader } = await corpusFor(v);
    const engine = new SearchEngine(loader);
    const graph = await engine.getConnectionGraph('context/revenue-engine.md', 2, 0.1, 5);
    assert.equal(graph.root, 'context/revenue-engine.md');
    assert.equal(
      graph.connections.length,
      0,
      'with no current vector the node cannot expand; the old engine expanded it from a ' +
        'stale one and called the result a connection'
    );
  } finally {
    v.cleanup();
  }
});

test('5.4 getStats reports vault-world, not plugin-world', async () => {
  const v = makeVault();
  try {
    for (let i = 0; i < 5; i++) v.write(`n${i}.md`, `note ${i} ` + 'x'.repeat(300));
    writeSmartEnv(v.root, [{ path: 'n0.md', vec: fakeVec(51), hash: 'stale' }]);
    const { loader } = await corpusFor(v);
    const stats = await new SearchEngine(loader).getStats();
    assert.equal(stats.vaultNotes, 5, 'the old totalNotes was getSources().size, which is 1 here');
    assert.equal(stats.pluginSources, 1);
    assert.ok(stats.corpusGeneration > 0);
    assert.ok(Date.parse(stats.verifiedAt) > 0);
  } finally {
    v.cleanup();
  }
});

test('5.5 block headings for a stale note come from the CURRENT markdown', async () => {
  const v = makeVault();
  try {
    v.write('n.md', '# New Heading\n\n' + 'body '.repeat(60));
    writeSmartEnv(v.root, [
      {
        path: 'n.md',
        vec: fakeVec(61),
        hash: 'stale',
        blockRanges: { 'Old Heading From June': [1, 5] },
      },
    ]);
    const { loader } = await corpusFor(v);
    const note = await new SearchEngine(loader).getNoteWithContext('n.md');
    assert.deepEqual(
      note.blocks,
      ['New Heading'],
      'heading-to-line-range mappings are as suspect as the vectors once a file changes'
    );
  } finally {
    v.cleanup();
  }
});

// 6.x -- health that separates several different questions ------------------

test('6.1 health reports four separate facts, and the AND of them', async () => {
  const v = staleVault();
  try {
    const { loader } = await corpusFor(v);
    const health = await new SearchEngine(loader).checkSearchHealth();

    for (const field of [
      'semanticReady',
      'retrievalProbePassed',
      'freshnessVerified',
      'coverageComplete',
      'negativeResultsTrustworthy',
    ]) {
      assert.equal(typeof health[field], 'boolean', `${field} must be present and boolean`);
    }
    assert.ok(Date.parse(health.verifiedAt) > 0, 'a boolean you cannot date is worth much less');
    assert.ok(health.corpusGeneration > 0);

    // The whole point: this vault has a plugin index, probes could be run against
    // it, and it is still not trustworthy, because nothing in it is current.
    assert.equal(health.coverageComplete, false);
    assert.equal(health.negativeResultsTrustworthy, false);
    assert.equal(
      health.alive,
      false,
      'the old alive would have been TRUE here: probes drawn from the index came back, ' +
        'mode was semantic, and unsearchable computed to zero'
    );
  } finally {
    v.cleanup();
  }
});

test('6.2 the verdict says which of the four failed, in words', async () => {
  const v = staleVault();
  try {
    const { loader } = await corpusFor(v);
    const health = await new SearchEngine(loader).checkSearchHealth();
    assert.match(health.verdict, /NOTHING TO SEARCH|CONVERGING|BLIND|DEGRADED|NOT BE VERIFIED/);
    assert.ok(
      !/is current/.test(health.verdict),
      'a stale vault must never be described as current'
    );
  } finally {
    v.cleanup();
  }
});

test('6.3 coverage carries the same one field an agent has to read', async () => {
  const v = makeVault();
  try {
    v.write('a.md', 'a'.repeat(300));
    const loader = new SmartConnectionsLoader(v.root);
    await loader.initialize();
    const health = await new SearchEngine(loader).checkSearchHealth();
    assert.equal(health.coverage.freshnessVerified, health.freshnessVerified);
    assert.equal(health.coverage.coverageComplete, health.coverageComplete);
    assert.equal(health.coverage.corpusGeneration, health.corpusGeneration);
  } finally {
    v.cleanup();
  }
});
