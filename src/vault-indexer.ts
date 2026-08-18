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
 * CHUNKING. This used to embed each note whole, which quietly capped what search
 * could see. `SAFE_CHARS` is 1200, and on a real vault the median note runs
 * several thousand characters, so a note vector represented the opening and
 * nothing else. Measured on Dan's 630-note vault: retrieving a note from a
 * passage in its own body scored recall@1 of 15% on note vectors against 57% on
 * per-section vectors. That gap is not a ranking subtlety, it is most of every
 * long note having no representation at all.
 *
 * So notes are split on markdown headings and each section is embedded
 * separately, which is the same thing Smart Connections does and the actual
 * reason its index is better. The plugin is now a cache of work we can do
 * ourselves rather than a prerequisite for finding anything.
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
  /** Whole-note vector, kept so a note still matches on its overall gist. */
  vec: number[];
  /** Per-section vectors, the ones that make a note's body findable. */
  sections?: number[][];
  size: number;
  mtime: number;
}
type Cache = Record<string, CacheEntry>;

export interface SupplementalIndex {
  vectors: Map<string, number[]>;
  /** Per-section vectors by note path, mirroring the plugin's block index. */
  sections: Map<string, number[][]>;
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
/**
 * Split a note into heading-delimited sections small enough to embed whole.
 *
 * Mirrors Smart Connections' own granularity (one chunk per heading path) with a
 * hard character ceiling, because a single heading can still hold more prose than
 * the model window and a truncated chunk reintroduces the exact blindness this
 * exists to fix. Oversized sections are split on paragraph boundaries.
 *
 * The note's path rides on every chunk: location and filename carry real topic
 * signal, and a bare section body often does not say what it is about.
 */
export function splitIntoSections(relPath: string, text: string, maxChars = 1100): string[] {
  const lines = text.split('\n');
  const sections: string[] = [];
  let headingTrail: string[] = [];
  let buf: string[] = [];

  const flush = () => {
    const body = buf.join('\n').trim();
    buf = [];
    if (body.length < 40) return; // too short to carry meaning on its own
    const context = [relPath, ...headingTrail].join(' > ');
    // Long sections get split on blank lines rather than mid-sentence.
    if (context.length + body.length <= maxChars) {
      sections.push(`${context}\n\n${body}`);
      return;
    }
    let chunk: string[] = [];
    let size = 0;
    for (const para of body.split(/\n\s*\n/)) {
      if (size + para.length > maxChars - context.length && chunk.length) {
        sections.push(`${context}\n\n${chunk.join('\n\n')}`);
        chunk = [];
        size = 0;
      }
      chunk.push(para);
      size += para.length;
    }
    if (chunk.length) sections.push(`${context}\n\n${chunk.join('\n\n')}`);
  };

  for (const line of lines) {
    const m = /^(#{1,6})\s+(.*)$/.exec(line);
    if (m) {
      flush();
      const depth = m[1].length;
      headingTrail = headingTrail.slice(0, depth - 1);
      headingTrail[depth - 1] = m[2].trim();
      headingTrail = headingTrail.filter((h) => h !== undefined);
      continue;
    }
    buf.push(line);
  }
  flush();

  // A note with no headings at all still needs chunking, so fall back to the
  // whole body run through the same paragraph splitter.
  if (sections.length === 0 && text.trim().length >= 40) {
    headingTrail = [];
    buf = lines;
    flush();
  }
  return sections;
}

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
  const sections = new Map<string, number[][]>();
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
    // `sections === undefined` means the entry predates chunking. Reusing it
    // would leave those notes represented by their truncated opening forever,
    // since an unchanged file never invalidates on size or mtime. Treat a
    // section-less entry as stale, not as a hit.
    const cacheUsable =
      cached && cached.size === st.size && cached.mtime === st.mtimeMs && cached.sections !== undefined;
    if (cacheUsable) {
      vectors.set(rel, cached.vec);
      if (cached.sections && cached.sections.length) sections.set(rel, cached.sections);
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

    // Sections are what make the body of a long note reachable; the whole-note
    // vector above only ever represents its opening.
    const sectionVecs: number[][] = [];
    for (const section of splitIntoSections(rel, text)) {
      const sv = await embedText(section);
      if (!sv) break;
      sectionVecs.push(sv);
    }

    vectors.set(rel, vec);
    if (sectionVecs.length) sections.set(rel, sectionVecs);
    cache[rel] = { vec, sections: sectionVecs, size: st.size, mtime: st.mtimeMs };
    newlyEmbedded++;
    cacheDirty = true;
  }

  if (cacheDirty) saveCache(vaultPath, cache);

  return { vectors, sections, newlyEmbedded, missingFromPlugin: missing.length };
}
