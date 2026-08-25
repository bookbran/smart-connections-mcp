/**
 * Tracker 5.6: make bypassing the corpus hard in CODE, not just forbidden in prose.
 *
 * The failure this prevents is not a bug anyone would write on purpose. It is
 * the one that happens six months from now, when somebody adds
 * `find_related_projects()`, naturally reaches for `loader.getSources()` because
 * that is what every other example in the file used to do, and quietly unwinds
 * this entire build inside one function. Nothing would break. Nothing would look
 * wrong. The new tool would just answer from June.
 *
 * A comment saying "do not do this" does not fail a build. This does.
 *
 * The rule: retrieval modules rank against `CurrentCorpus`. Only the classifier
 * and the corpus assembler may touch the raw plugin index, because deciding
 * which raw vectors are trustworthy is precisely their job.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';

const SRC = new URL('../src/', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');

/** The two files whose job IS to look at raw plugin data. */
const CLASSIFIERS = new Set(['corpus-state.ts', 'current-corpus.ts', 'smart-connections-loader.ts']);

/** Raw plugin access that must not appear in a retrieval module. */
const FORBIDDEN = [
  { pattern: /\.getSources\(\)/, why: 'the raw plugin source map: it holds stale vectors' },
  { pattern: /\.getBlockVectors\(\)/, why: 'raw plugin block vectors: a stale block can outrank a fresh note' },
  { pattern: /\.getSource\(/, why: 'a raw plugin source record' },
];

/**
 * Currently empty, and that is the interesting part.
 *
 * The two accesses that looked like legitimate exceptions were both REPORTING
 * how many entries the plugin index holds. They became `loader.getSourceCount()`
 * instead, which says what it is. A count of index entries is a fact about the
 * plugin; a map of index entries is evidence about notes, and only the
 * classifier is allowed to weigh that.
 *
 * If a genuine exception ever appears, add it here WITH a reason in the same
 * commit. An exception without a reason is how a rule stops meaning anything.
 */
const ALLOWED_EXCEPTIONS = {};

test('5.6 no retrieval module reaches past CurrentCorpus to the raw plugin index', () => {
  const offenders = [];
  for (const file of readdirSync(SRC).filter((f) => f.endsWith('.ts'))) {
    if (CLASSIFIERS.has(file)) continue;
    const source = readFileSync(join(SRC, file), 'utf-8');
    // Strip comments, so a comment explaining WHY not to call getSources() does
    // not itself trip the check.
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

    let hits = 0;
    for (const { pattern } of FORBIDDEN) {
      hits += (code.match(new RegExp(pattern.source, 'g')) || []).length;
    }
    const allowed = ALLOWED_EXCEPTIONS[file] ?? 0;
    if (hits > allowed) {
      offenders.push(`${file}: ${hits} raw plugin accesses, ${allowed} sanctioned`);
    }
  }

  assert.deepEqual(
    offenders,
    [],
    'Raw plugin access outside the classifier. Rank against CurrentCorpus instead: it holds ' +
      'only vectors a reconciled snapshot vouched for. If this access really is a count ' +
      'rather than evidence about a note, raise the sanctioned number in ALLOWED_EXCEPTIONS ' +
      'and say why in the same commit.\n' +
      offenders.join('\n')
  );
});

test('5.6 the sanctioned exceptions are counts, not vectors', () => {
  const source = readFileSync(join(SRC, 'search-engine.ts'), 'utf-8');
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  for (const line of code.split('\n')) {
    if (!/\.getSources\(\)/.test(line)) continue;
    assert.match(
      line,
      /\.size/,
      `search-engine may ask the plugin HOW MANY sources it has, never WHICH: ${line.trim()}`
    );
  }
});
