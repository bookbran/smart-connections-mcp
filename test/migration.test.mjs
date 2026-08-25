/**
 * Phase 10: the migration path, where the backlog actually bites.
 *
 * Migration is the one moment that dumps hundreds of notes into a brain at once,
 * and it is also the moment a member is most likely to arrive carrying a stale
 * `.smart-env` from an Obsidian install they stopped opening. That is this bug,
 * pre-installed, arriving as a gift.
 *
 * The thing being asserted throughout: an imported index gets NO special
 * handling. Not a special case, not a cleanup step, not a warning to delete it.
 * Every entry is checked against the note on disk exactly like any other, and
 * after a long gap that means almost none of them are used. Special-casing it
 * would be a second freshness rule, and two freshness rules is how the first
 * one stops being true.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { join } from 'path';

import { SmartConnectionsLoader } from '../dist/smart-connections-loader.js';
import { SearchEngine } from '../dist/search-engine.js';
import { CorpusProvider } from '../dist/current-corpus.js';
import { embedderAvailable } from '../dist/embedder.js';
import { makeVault, writeSmartEnv, fakeVec, smartConnectionsHash } from './helpers.mjs';

const MODEL_UP = await embedderAvailable('TaylorAI/bge-micro-v2').catch(() => false);

/**
 * A vault as it arrives from a migration: a pile of notes, and an `.smart-env`
 * built months ago from what those notes used to say.
 */
function migratedVault(noteCount = 12) {
  const v = makeVault('sc-migrated-');
  const sources = [];
  for (let i = 0; i < noteCount; i++) {
    const oldText = `# Note ${i}\n\nThis is what note ${i} said back in June, before it was edited.\n`;
    // One TOKEN per note, not a hyphenated phrase: the lexical scorer splits on
    // non-alphanumerics and drops single characters, so `pelmet-7-quorum` reduces
    // to `pelmet` and `quorum`, which every note here contains.
    const nowText = `# Note ${i}\n\nThis is what note ${i} says today. Unique token: pelmetq${i}x.\n`;
    v.write(`old-vault/note-${i}.md`, nowText);
    sources.push({
      path: `old-vault/note-${i}.md`,
      vec: fakeVec(1000 + i),
      hash: smartConnectionsHash(oldText),
      blocks: [{ heading: `Note ${i}`, vec: fakeVec(2000 + i) }],
      blockRanges: { [`Note ${i}`]: [1, 3] },
    });
  }
  writeSmartEnv(v.root, sources);
  return v;
}

test('10.3 an imported .smart-env is treated as suspect, with no special case', async () => {
  const v = migratedVault();
  try {
    const loader = new SmartConnectionsLoader(v.root);
    await loader.initialize();
    const corpus = await new CorpusProvider(loader, v.root).get({ skipIndexing: true });

    assert.equal(loader.getSourceCount(), 12, 'the imported index really is populated');
    assert.equal(corpus.state.pluginStale.size, 12, 'and every entry of it is stale');
    assert.equal(corpus.state.pluginFresh.size, 0);
    assert.equal(
      corpus.noteVectors.size,
      0,
      'not one imported vector may be ranked. The member stopped opening Obsidian, so ' +
        'every vector describes a version of a note that no longer exists.'
    );
    assert.equal(corpus.sectionVectors.size, 0, 'blocks go with their source');
    assert.equal(corpus.state.semanticPending.size, 12, 'all of it is work to do');
  } finally {
    v.cleanup();
  }
});

test('10.3 a migrated vault comes up with HONEST coverage, not a false zero', async () => {
  const v = migratedVault();
  try {
    const loader = new SmartConnectionsLoader(v.root);
    await loader.initialize();
    const engine = new SearchEngine(loader);

    // Budgets pinned to zero so this measures the REPORT rather than racing the
    // repair. Zero is a real configuration, not a test hook.
    process.env.SMART_INDEX_EMBED_BUDGET = '0';
    process.env.SMART_INDEX_INTERACTIVE_EMBED_BUDGET = '0';
    let health;
    try {
      health = await engine.checkSearchHealth();
    } finally {
      delete process.env.SMART_INDEX_EMBED_BUDGET;
      delete process.env.SMART_INDEX_INTERACTIVE_EMBED_BUDGET;
    }

    assert.equal(health.coverage.plugin.sources, 12);
    assert.equal(health.coverage.plugin.stale, 12);
    assert.equal(health.coverage.semantic.searchable, 0);
    assert.equal(
      health.coverage.semantic.pending,
      12,
      'the old coverage maths reported unsearchable: 0 in exactly this situation'
    );
    assert.equal(health.coverage.lexical.searchable, 12, 'lexical covers it all immediately');
    assert.equal(health.negativeResultsTrustworthy, false);
    assert.equal(health.coverageComplete, false);
  } finally {
    v.cleanup();
  }
});

test('10.3 a migrated note is findable by its CURRENT words from the first second', async () => {
  const v = migratedVault();
  try {
    const loader = new SmartConnectionsLoader(v.root);
    await loader.initialize();
    const engine = new SearchEngine(loader);
    const corpus = await new CorpusProvider(loader, v.root).get({ skipIndexing: true });

    // The reason a backlog is survivable rather than catastrophic. Nothing has
    // been embedded, and the note is still reachable by a distinctive phrase.
    const hits = engine.searchByKeyword('pelmetq7x', corpus, 5, 0);
    assert.ok(
      hits.some((h) => h.path === 'old-vault/note-7.md'),
      'a migrated note must be findable immediately, before any embedding happens'
    );

    // And the text it USED to hold must not answer for it.
    const ghosts = engine.searchByKeyword('back in June before it was edited', corpus, 5, 0.6);
    assert.equal(ghosts.length, 0, 'the old text is gone and must not be findable');
  } finally {
    v.cleanup();
  }
});

test('10.2 migration finishes its backlog with refresh_search_index, resumably', { skip: !MODEL_UP }, async () => {
  const v = migratedVault(6);
  try {
    const loader = new SmartConnectionsLoader(v.root);
    await loader.initialize();
    const engine = new SearchEngine(loader);

    // A budget too small to finish, which is the migration case: hundreds of
    // notes arriving against a bounded cap.
    const first = await engine.refreshSearchIndex(3);
    assert.ok(first.refreshed > 0);
    assert.ok(first.remaining > 0, 'a real migration does not finish in one pass');
    assert.equal(first.coverageComplete, false);

    let report = first;
    let rounds = 0;
    while (report.remaining > 0 && rounds < 10) {
      report = await engine.refreshSearchIndex(3);
      rounds++;
    }

    assert.equal(report.remaining, 0, 'repeated calls must converge');
    assert.equal(report.coverageComplete, true);
    assert.equal(report.failed, 0);

    // Idempotent at the end: nothing left to spend anything on.
    const noop = await engine.refreshSearchIndex(100);
    assert.equal(noop.embedCalls, 0);
    assert.equal(noop.refreshed, 0);

    const health = await engine.checkSearchHealth();
    assert.equal(health.negativeResultsTrustworthy, true, 'and then absence means something');
  } finally {
    v.cleanup();
  }
});

test('10.4 the report carries what a manifest needs to record', async () => {
  const v = migratedVault(3);
  try {
    const loader = new SmartConnectionsLoader(v.root);
    await loader.initialize();
    const engine = new SearchEngine(loader);

    process.env.SMART_INDEX_EMBED_BUDGET = '0';
    let report;
    try {
      report = await engine.refreshSearchIndex();
    } finally {
      delete process.env.SMART_INDEX_EMBED_BUDGET;
    }

    // A member reading the manifest a week later should not have to guess
    // whether the thin answer they got on day one meant their notes were
    // missing. These are the fields that answer that.
    for (const field of [
      'attempted', 'refreshed', 'alreadyCurrent', 'failed', 'remaining',
      'raced', 'embedCalls', 'budget', 'corpusGeneration', 'verifiedAt',
      'coverageComplete', 'summary',
    ]) {
      assert.ok(field in report, `refresh report must carry ${field}`);
    }
    assert.equal(typeof report.summary, 'string');
    assert.ok(report.summary.length > 0);
    assert.ok(Date.parse(report.verifiedAt) > 0);
    assert.equal(report.coverageComplete, false);
    assert.match(report.summary, /pending/, 'an unfinished run must say so in words');
  } finally {
    v.cleanup();
  }
});
