/**
 * Phase 7: two operating modes, not one budget.
 *
 * These run the REAL embedding model against a real temp vault, because the
 * questions being asked are about what happens across interruptions and repeat
 * calls, and a stubbed embedder would answer them the way I assumed rather than
 * the way the code behaves. The model is cached under node_modules after the
 * first load.
 *
 * Skipped, loudly, when the model cannot load. A test that silently passes
 * because it did nothing is worse than one that says it was skipped.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { SmartConnectionsLoader } from '../dist/smart-connections-loader.js';
import { SearchEngine } from '../dist/search-engine.js';
import { CorpusProvider } from '../dist/current-corpus.js';
import { embedderAvailable } from '../dist/embedder.js';
import { makeVault } from './helpers.mjs';

const MODEL_UP = await embedderAvailable('TaylorAI/bge-micro-v2').catch(() => false);
if (!MODEL_UP) {
  console.error('[skip] embedding model unavailable; Phase 7 behaviour tests did not run');
}

/** Small notes, so a full pass is a handful of embed calls rather than minutes. */
function tinyVault(count = 4) {
  const v = makeVault();
  for (let i = 0; i < count; i++) {
    v.write(
      `notes/n${i}.md`,
      `# Note ${i}\n\nThis note is about subject-${i} and says enough to be worth embedding.\n`
    );
  }
  return v;
}

test('7.3 refresh_search_index is resumable: a budget stops it, a second call continues', { skip: !MODEL_UP }, async () => {
  const v = tinyVault(4);
  try {
    const loader = new SmartConnectionsLoader(v.root);
    await loader.initialize();
    const engine = new SearchEngine(loader);

    // One embed call is one note plus its sections, so a budget of 2 cannot
    // finish four notes.
    const first = await engine.refreshSearchIndex(2);
    assert.ok(first.refreshed > 0, 'something must get done');
    assert.ok(first.remaining > 0, 'and the budget must actually stop it');
    assert.equal(first.coverageComplete, false);
    assert.match(first.summary, /pending/);

    const second = await engine.refreshSearchIndex(100);
    assert.equal(second.remaining, 0, 'the second call finishes what the first started');
    assert.equal(second.coverageComplete, true);
    assert.ok(
      second.alreadyCurrent > 0,
      'and it must SKIP what the first call already did rather than redoing it'
    );
    assert.match(second.summary, /caught up/);
  } finally {
    v.cleanup();
  }
});

test('7.3 refresh_search_index is idempotent: running it again spends nothing', { skip: !MODEL_UP }, async () => {
  const v = tinyVault(3);
  try {
    const loader = new SmartConnectionsLoader(v.root);
    await loader.initialize();
    const engine = new SearchEngine(loader);

    await engine.refreshSearchIndex(100);
    const again = await engine.refreshSearchIndex(100);
    assert.equal(again.refreshed, 0);
    assert.equal(again.embedCalls, 0, 'a converged vault must cost zero embed calls');
    assert.equal(again.remaining, 0);
    assert.equal(again.coverageComplete, true);
  } finally {
    v.cleanup();
  }
});

test('7.3 an edit after convergence makes exactly that note pending again', { skip: !MODEL_UP }, async () => {
  const v = tinyVault(3);
  try {
    const loader = new SmartConnectionsLoader(v.root);
    await loader.initialize();
    const engine = new SearchEngine(loader);
    await engine.refreshSearchIndex(100);

    // Same size, timestamp preserved. The case that defeats a metadata cache.
    const edited = '# Note 1\n\nThis note is about SUBJECT-X and says enough to be worth embedding.\n';
    v.writePreservingTime('notes/n1.md', edited, 1000000);

    const after = await engine.refreshSearchIndex(100);
    assert.equal(after.refreshed, 1, 'exactly the edited note, and no others');
    assert.equal(after.alreadyCurrent, 2);
    assert.equal(after.coverageComplete, true);
  } finally {
    v.cleanup();
  }
});

test('7.1 an interactive query never drains the general backlog', { skip: !MODEL_UP }, async () => {
  const v = tinyVault(12);
  try {
    // A distinctive multi-character token. The lexical tokenizer drops
    // single-character terms, so "subject-7" reduces to "subject", which every
    // note contains: a real property of the scorer, not worth working around
    // here, but worth knowing when writing a query.
    v.write('notes/target.md', '# Target\n\nThe only note mentioning ptarmigan-lithography anywhere.\n');

    const loader = new SmartConnectionsLoader(v.root);
    await loader.initialize();
    const engine = new SearchEngine(loader);

    process.env.SMART_INDEX_INTERACTIVE_EMBED_BUDGET = '2';
    const response = await engine.searchByQuery('ptarmigan-lithography', 5, 0.3);
    delete process.env.SMART_INDEX_INTERACTIVE_EMBED_BUDGET;

    assert.ok(
      response.coverage.semantic.pending > 0,
      'a query must NOT spend whatever budget is left before returning: that is the ' +
        'multi-minute first query the cap exists to prevent'
    );
    assert.ok(
      response.coverage.semantic.searchable < 13,
      'and it must not have embedded the whole vault on the way'
    );
    // But it still answered, because lexical covers everything immediately.
    assert.ok(
      response.results.some((r) => r.path === 'notes/target.md'),
      'the note asked for must come back even though most of the vault is unembedded'
    );
  } finally {
    v.cleanup();
  }
});

test('7.2 repair prioritizes the query-relevant note over directory order', { skip: !MODEL_UP }, async () => {
  const v = makeVault();
  try {
    // Twenty notes, and the interesting one is LAST in directory order, which is
    // where the old round-robin would have left it waiting.
    for (let i = 0; i < 20; i++) {
      v.write(`notes/a${String(i).padStart(2, '0')}.md`, `# Filler ${i}\n\nOrdinary filler content about nothing in particular, repeated.\n`);
    }
    v.write('notes/zzz-last.md', '# Target\n\nThis is the only note that mentions ptarmigan-lithography.\n');

    const loader = new SmartConnectionsLoader(v.root);
    await loader.initialize();
    const engine = new SearchEngine(loader);

    process.env.SMART_INDEX_INTERACTIVE_EMBED_BUDGET = '3';
    await engine.searchByQuery('ptarmigan-lithography', 5, 0.3);
    delete process.env.SMART_INDEX_INTERACTIVE_EMBED_BUDGET;

    const provider = new CorpusProvider(loader, v.root);
    const corpus = await provider.get({ skipIndexing: true });
    assert.ok(
      corpus.noteVectors.has('notes/zzz-last.md'),
      'the query-relevant note must be repaired first. Directory order would have put it ' +
        'behind twenty unrelated notes, which is the worst possible ordering: the note a ' +
        'member is asking about is usually the note they just wrote.'
    );
  } finally {
    v.cleanup();
  }
});

test('7.4 both budgets are configurable, and the interactive one is the smaller', async () => {
  const { DEFAULT_EMBED_BUDGET } = await import('../dist/vault-indexer.js');
  const { DEFAULT_INTERACTIVE_EMBED_BUDGET } = await import('../dist/search-engine.js');
  assert.equal(DEFAULT_EMBED_BUDGET, 3000, 'the total cap stays where it is');
  assert.ok(
    DEFAULT_INTERACTIVE_EMBED_BUDGET < DEFAULT_EMBED_BUDGET / 10,
    'interactive work gets a MUCH smaller slice, or a first query takes minutes'
  );
});
