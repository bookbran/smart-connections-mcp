/**
 * Retrieval eval: does the plugin's per-block index actually buy anything?
 *
 * Roy asked for this to be measured rather than decided (apc-ai-course#103), and
 * Dan's vault is the largest honest test available. The question turned out to be
 * sharper than expected: the plugin computes ~14k block embeddings and the MCP
 * server reads none of them (smart-connections-loader.ts:110), ranking on
 * note-level vectors alone. So the comparison is not plugin-vs-no-plugin, it is
 * what-we-use vs what-we-already-have-and-ignore.
 *
 * Method. Pick notes at random, pull a distinctive passage from the MIDDLE of
 * each (never the title, never the opening line, so a title match cannot carry
 * it), and use that passage as a query. The source note is the known answer.
 * Score recall@1, recall@5 and MRR for each ranking strategy.
 *
 * Caveat worth stating: passage-as-query is not the same distribution as a real
 * member's question, which is usually shorter and more abstract than any literal
 * passage. It is a fair RELATIVE comparison between two indexes over identical
 * queries, not an absolute quality number.
 */

import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { embedText } from './dist/embedder.js';

const VAULT = 'C:/Users/danie/OneDrive/Desktop/JDH-Second-Brain';
const MODEL = 'TaylorAI/bge-micro-v2';
const ENV_DIR = join(VAULT, '.smart-env', 'multi');
const N_QUERIES = 60;

function cosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
}

// ---- load both indexes out of the plugin's own store -------------------------
const noteVecs = new Map();            // path -> vec
const blockVecs = new Map();           // path -> [vec, vec, ...]

for (const file of readdirSync(ENV_DIR).filter((f) => f.endsWith('.ajson'))) {
  let raw;
  try { raw = readFileSync(join(ENV_DIR, file), 'utf-8'); } catch { continue; }
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    const sep = line.indexOf('": ');
    if (sep < 0) continue;
    const key = line.slice(1, sep);
    let val;
    try { val = JSON.parse(line.slice(sep + 3).replace(/,$/, '')); } catch { continue; }
    const vec = val?.embeddings?.[MODEL]?.vec;
    if (!vec || !vec.length) continue;

    if (key.startsWith('smart_sources:')) {
      noteVecs.set(key.slice('smart_sources:'.length), vec);
    } else if (key.startsWith('smart_blocks:')) {
      const path = key.slice('smart_blocks:'.length).split('#')[0];
      if (!blockVecs.has(path)) blockVecs.set(path, []);
      blockVecs.get(path).push(vec);
    }
  }
}

const totalBlocks = [...blockVecs.values()].reduce((n, v) => n + v.length, 0);
console.log(`Indexes loaded: ${noteVecs.size} note vectors, ${totalBlocks} block vectors across ${blockVecs.size} notes.\n`);

// ---- build the query set ----------------------------------------------------
// Deterministic stride over the sorted note list so this is reproducible.
const candidates = [...noteVecs.keys()].sort();
const queries = [];
const stride = Math.max(1, Math.floor(candidates.length / (N_QUERIES * 3)));

for (let i = 0; i < candidates.length && queries.length < N_QUERIES; i += stride) {
  const path = candidates[i];
  let text;
  try { text = readFileSync(join(VAULT, path), 'utf-8'); } catch { continue; }

  // Real prose only: drop headings, list bullets, frontmatter, code and tables.
  const lines = text.split('\n');
  const body = lines
    .slice(Math.floor(lines.length * 0.35))          // skip the top third entirely
    .filter((l) => {
      const t = l.trim();
      return t.length > 90 && !t.startsWith('#') && !t.startsWith('-') &&
             !t.startsWith('|') && !t.startsWith('>') && !t.startsWith('`') &&
             !t.startsWith('*') && !/^\d+\./.test(t);
    });
  if (!body.length) continue;

  let passage;
  if (process.env.EVAL_MODE === 'title') {
    // Counter-test: short, abstract, title-shaped queries. This is the
    // distribution that should favour whole-note vectors, since a note vector is
    // a summary of the whole note and a title is too.
    const base = path.split('/').pop().replace(/\.md$/i, '').replace(/[-_]+/g, ' ');
    const h1 = lines.find((l) => l.trim().startsWith('# '));
    passage = (h1 ? h1.replace(/^#\s*/, '').trim() : base).slice(0, 120);
  } else {
    passage = body[Math.floor(body.length / 2)].trim().slice(0, 320);
  }
  queries.push({ path, passage });
}

console.log(`Query set: ${queries.length} passages drawn from note bodies.\n`);

// ---- score ------------------------------------------------------------------
const strategies = {
  'note-level (what search uses today)': (qv) =>
    [...noteVecs.entries()].map(([p, v]) => [p, cosine(qv, v)]),

  'block-level max (computed, never read)': (qv) =>
    [...blockVecs.entries()].map(([p, vs]) => {
      let best = -1;
      for (const v of vs) { const s = cosine(qv, v); if (s > best) best = s; }
      return [p, best];
    }),

  'hybrid: max(note, best block)': (qv) => {
    const scores = new Map();
    for (const [p, v] of noteVecs) scores.set(p, cosine(qv, v));
    for (const [p, vs] of blockVecs) {
      let best = -1;
      for (const v of vs) { const s = cosine(qv, v); if (s > best) best = s; }
      scores.set(p, Math.max(scores.get(p) ?? -1, best));
    }
    return [...scores.entries()];
  },
};

const results = {};
for (const name of Object.keys(strategies)) results[name] = { r1: 0, r5: 0, mrr: 0, n: 0 };

for (const { path, passage } of queries) {
  const qv = await embedText(passage, MODEL);
  if (!qv || !qv.length) continue;

  for (const [name, rank] of Object.entries(strategies)) {
    const ordered = rank(qv).sort((a, b) => b[1] - a[1]);
    const pos = ordered.findIndex(([p]) => p === path);
    const r = results[name];
    r.n++;
    if (pos === 0) r.r1++;
    if (pos >= 0 && pos < 5) r.r5++;
    if (pos >= 0) r.mrr += 1 / (pos + 1);
  }
}

console.log('Strategy                                  recall@1   recall@5   MRR');
console.log('-'.repeat(72));
for (const [name, r] of Object.entries(results)) {
  const pct = (x) => (100 * x / r.n).toFixed(1).padStart(5) + '%';
  console.log(name.padEnd(42) + pct(r.r1) + '     ' + pct(r.r5) + '     ' + (r.mrr / r.n).toFixed(3));
}
console.log(`\nn = ${results[Object.keys(results)[0]].n} queries`);
