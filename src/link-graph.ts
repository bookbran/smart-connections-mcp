/**
 * The vault's LINK graph, as distinct from its semantic graph.
 *
 * WHY BOTH. Everything else in this server ranks by embedding similarity, which
 * answers "what is about the same thing as this?" That is the graph the vault
 * computes for you, and it finds connections nobody remembered to make. It
 * cannot answer a different and equally common question: "what explicitly points
 * at this note?" Those edges are authored, not inferred. A decision note that six
 * other notes cite is load-bearing in a way that has nothing to do with how
 * similar its prose is to theirs.
 *
 * Until now that graph existed only inside Obsidian, which made the app quietly
 * load-bearing for anyone who wanted backlinks or wanted `[[Shippy]]` to mean a
 * particular file. Since the kit puts Obsidian off the day-one path, the graph
 * has to live somewhere the kit actually installs. That is here.
 *
 * ALIASES ARE NOT OPTIONAL. Obsidian resolves `aliases:` frontmatter, so a
 * tracker named `2026-06-23-throughline-workstream.md` carrying
 * `aliases: [Throughline]` is legitimately reachable as `[[Throughline]]`.
 * A resolver that ignores that reports a healthy vault as full of broken links,
 * which is the worse direction to be wrong in: a checker that cries wolf gets
 * switched off. (Observed 2026-08-18 on a first pass that flagged every
 * firstmate tracker codename as missing.)
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import { listMarkdown } from './vault-indexer.js';

export interface LinkGraph {
  /** Every lowercased spelling that resolves to a note, mapped to its path. */
  index: Map<string, string>;
  /** note path -> note paths it links to */
  edges: Map<string, Set<string>>;
  /** note path -> note paths that link to it */
  backlinks: Map<string, Set<string>>;
  /** raw link text that resolves to nothing -> the notes that reference it */
  unresolved: Map<string, Set<string>>;
  noteCount: number;
}

/**
 * Link targets that are structural rather than notes: folder shorthand and the
 * placeholders documentation uses when explaining the syntax. Reporting these as
 * broken is noise, and noise is what stops people reading the report.
 */
const NOT_NOTES = new Set([
  'filename', 'contacts', 'projects', 'daily', 'personal', 'intelligence',
  'note name', 'some note', 'title', 'name', 'link',
]);

/** Fenced and inline code: `[[example]]` in docs is syntax, not a reference. */
const CODE = /```[\s\S]*?```|`[^`\n]*`/g;
const LINK = /\[\[([^\]|#]+)/g;

/**
 * Every spelling Obsidian will accept for this note: bare filename, full
 * vault-relative path, that path without the extension, and each declared alias.
 */
function spellings(rel: string, text: string): string[] {
  const base = rel.split('/').pop() || rel;
  const out = [
    base.replace(/\.md$/i, '').toLowerCase(),
    rel.toLowerCase(),
    rel.replace(/\.md$/i, '').toLowerCase(),
  ];
  if (!text.startsWith('---')) return out;
  const end = text.indexOf('\n---', 3);
  if (end < 0) return out;
  const fm = text.slice(3, end);

  const push = (raw: string) => {
    const v = raw.trim().replace(/^["']|["']$/g, '');
    if (v) out.push(v.toLowerCase());
  };

  const inline = /^aliases:[ \t]*\[(.*?)\]/m.exec(fm);
  if (inline) {
    inline[1].split(',').forEach(push);
    return out;
  }
  // Indented-list form. Stops at the first non-list line so a later key is safe.
  const lines = fm.split(/\r?\n/);
  const at = lines.findIndex((l) => /^aliases:[ \t]*$/.test(l));
  if (at >= 0) {
    for (let i = at + 1; i < lines.length; i++) {
      const m = /^[ \t]*-[ \t]*(.+)$/.exec(lines[i]);
      if (!m) break;
      push(m[1]);
    }
  }
  return out;
}

export function buildLinkGraph(vaultPath: string): LinkGraph {
  const rels = listMarkdown(vaultPath);
  const index = new Map<string, string>();
  const bodies = new Map<string, string>();

  for (const rel of rels) {
    let text = '';
    try {
      text = readFileSync(join(vaultPath, rel), 'utf-8');
    } catch {
      /* unreadable notes still resolve by name */
    }
    bodies.set(rel, text);
    for (const s of spellings(rel, text)) {
      // First writer wins, so a real file is never shadowed by another note's
      // alias. Collisions are rare and silently preferring the alias would make
      // a link point somewhere its author did not mean.
      if (!index.has(s)) index.set(s, rel);
    }
  }

  const edges = new Map<string, Set<string>>();
  const backlinks = new Map<string, Set<string>>();
  const unresolved = new Map<string, Set<string>>();

  for (const rel of rels) {
    const text = bodies.get(rel) || '';
    const stripped = text.replace(CODE, '');
    for (const m of stripped.matchAll(LINK)) {
      const raw = m[1].trim();
      if (!raw) continue;
      const key = raw.toLowerCase();
      const target = index.get(key);
      if (!target) {
        if (NOT_NOTES.has(key)) continue;
        if (!unresolved.has(raw)) unresolved.set(raw, new Set());
        unresolved.get(raw)!.add(rel);
        continue;
      }
      if (target === rel) continue; // self-links add nothing
      if (!edges.has(rel)) edges.set(rel, new Set());
      edges.get(rel)!.add(target);
      if (!backlinks.has(target)) backlinks.set(target, new Set());
      backlinks.get(target)!.add(rel);
    }
  }

  return { index, edges, backlinks, unresolved, noteCount: rels.length };
}

/**
 * Resolve one wikilink the way Obsidian would.
 *
 * Returns the match plus HOW it matched, because "resolved via an alias" is a
 * different fact from "resolved by filename" when a caller is deciding whether
 * to trust it. `null` means genuinely unresolvable, and the caller should treat
 * that as a missing note rather than a missing answer.
 */
export function resolveLink(
  graph: LinkGraph,
  link: string
): { path: string; matchedVia: 'filename' | 'path' | 'alias' } | null {
  // Tolerate the display and heading halves so a caller can paste a link whole.
  const bare = link.replace(/^\[\[|\]\]$/g, '').split('|')[0].split('#')[0].trim();
  const key = bare.toLowerCase();
  const path = graph.index.get(key);
  if (!path) return null;

  const base = (path.split('/').pop() || path).replace(/\.md$/i, '').toLowerCase();
  if (key === path.toLowerCase() || key === path.replace(/\.md$/i, '').toLowerCase()) {
    return { path, matchedVia: 'path' };
  }
  return { path, matchedVia: key === base ? 'filename' : 'alias' };
}

/**
 * Unresolved targets, ranked by how many DISTINCT notes reference them.
 *
 * One note pointing at an unwritten note is an ordinary forward reference and
 * healthy. Six notes pointing at the same missing target means the vault is
 * treating it as real, and it is either a concept that never got a home note or
 * a note that exists only on another machine. Both are worth surfacing; a single
 * stray link is not.
 */
export function integrityReport(graph: LinkGraph, minRefs = 3) {
  const all = [...graph.unresolved.entries()]
    .map(([target, from]) => ({ target, referencedBy: [...from].sort() }))
    .sort((a, b) => b.referencedBy.length - a.referencedBy.length);
  return {
    noteCount: graph.noteCount,
    unresolvedCount: all.length,
    loadBearing: all.filter((u) => u.referencedBy.length >= minRefs),
    all,
  };
}
