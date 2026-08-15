/**
 * Embedding the notes Smart Connections hasn't got to yet.
 *
 * WHY. Smart Connections only re-embeds while Obsidian is open. Anything written
 * since it last ran is absent from `.smart-env`, so semantic search silently
 * skips it: `get_similar_notes` answers "Note not found" and a query search
 * returns the second-best note without ever mentioning that the best one was
 * invisible. That is the same failure shape as a search tool returning `[]`
 * because of a bad threshold. It looks like an answer.
 *
 * Now that the server can embed text for queries it can also embed these, so the
 * index no longer depends on remembering to open Obsidian. Results are cached on
 * disk keyed by size and mtime, so a note is embedded once and re-embedded only
 * when it actually changes.
 *
 * This supplements Smart Connections rather than replacing it. The plugin remains
 * the primary index (it does block-level embeddings, which this does not); this
 * only fills the gap for whole notes it has not seen.
 */

import { readFileSync, writeFileSync, existsSync, readdirSync, statSync, mkdirSync } from 'fs';
import { join, relative, sep } from 'path';
import { embedText } from './embedder.js';

const CACHE_FILE = '.smart-env/mcp-supplemental.json';

/** Mirrors what Smart Connections itself skips, plus our own cache. */
const SKIP_DIRS = new Set([
  '.obsidian',
  '.smart-env',
  '.git',
  '.trash',
  'node_modules',
  '.stfolder',
]);

interface CacheEntry {
  vec: number[];
  size: number;
  mtime: number;
}
type Cache = Record<string, CacheEntry>;

export interface SupplementalIndex {
  vectors: Map<string, number[]>;
  /** Notes embedded during this run, so the caller can report the catch-up. */
  newlyEmbedded: number;
  /** Notes on disk that Smart Connections has never seen. */
  missingFromPlugin: number;
}

function listMarkdown(root: string, dir = root, out: string[] = []): string[] {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (e.name.startsWith('.') && SKIP_DIRS.has(e.name)) continue;
    const full = join(dir, e.name);
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      listMarkdown(root, full, out);
    } else if (e.name.toLowerCase().endsWith('.md')) {
      // Smart Connections keys everything by forward-slashed vault-relative path.
      out.push(relative(root, full).split(sep).join('/'));
    }
  }
  return out;
}

function loadCache(vaultPath: string): Cache {
  const p = join(vaultPath, CACHE_FILE);
  if (!existsSync(p)) return {};
  try {
    return JSON.parse(readFileSync(p, 'utf-8')) as Cache;
  } catch {
    // A corrupt cache is not worth failing over; re-embedding is merely slower.
    return {};
  }
}

function saveCache(vaultPath: string, cache: Cache): void {
  try {
    // On a machine where Smart Connections has never run there is no `.smart-env`
    // to write into, and without this the cache silently failed to save and every
    // startup re-embedded the entire vault. That is precisely the no-Obsidian
    // case this server now supports, so the directory gets created.
    mkdirSync(join(vaultPath, '.smart-env'), { recursive: true });
    writeFileSync(join(vaultPath, CACHE_FILE), JSON.stringify(cache), 'utf-8');
  } catch {
    // Losing the cache costs time on the next run and nothing else.
  }
}

/**
 * Embed every note the plugin has not indexed. `knownPaths` is what Smart
 * Connections already covers, which we never duplicate.
 *
 * `maxNotes` bounds a first run on a vault that has drifted badly, so the first
 * query after a long gap does not hang. Anything beyond the cap is embedded on
 * the next call, and the count is reported rather than hidden.
 */
export async function buildSupplementalIndex(
  vaultPath: string,
  knownPaths: Set<string>,
  // High enough that a machine with no Smart Connections index at all covers a
  // whole vault in one pass. Measured at roughly 16ms per note, so 2000 notes is
  // about 30 seconds once, and never again thanks to the cache. The cap exists
  // only so an enormous vault cannot hang the first query forever.
  maxNotes = 2000
): Promise<SupplementalIndex> {
  const cache = loadCache(vaultPath);
  const vectors = new Map<string, number[]>();
  const missing = listMarkdown(vaultPath).filter((p) => !knownPaths.has(p));

  let newlyEmbedded = 0;
  let cacheDirty = false;

  for (const rel of missing) {
    let st;
    try {
      st = statSync(join(vaultPath, rel));
    } catch {
      continue;
    }

    const cached = cache[rel];
    if (cached && cached.size === st.size && cached.mtime === st.mtimeMs) {
      vectors.set(rel, cached.vec);
      continue;
    }

    if (newlyEmbedded >= maxNotes) continue;

    let text: string;
    try {
      text = readFileSync(join(vaultPath, rel), 'utf-8');
    } catch {
      continue;
    }
    if (text.trim().length < 50) continue;

    // `embedQuery` owns truncation, since only it knows the model's real limit
    // and it steps the budget down if a note tokenizes densely. The path goes in
    // ahead of the body because a note's location and filename say a lot about
    // its topic, and the opening carries the rest.
    const vec = await embedText(`${rel}\n\n${text}`);
    if (!vec) break; // Model unavailable; leave the rest for a later run.

    vectors.set(rel, vec);
    cache[rel] = { vec, size: st.size, mtime: st.mtimeMs };
    newlyEmbedded++;
    cacheDirty = true;
  }

  if (cacheDirty) saveCache(vaultPath, cache);

  return { vectors, newlyEmbedded, missingFromPlugin: missing.length };
}
