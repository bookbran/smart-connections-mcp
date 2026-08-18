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
export declare function buildLinkGraph(vaultPath: string): LinkGraph;
/**
 * Resolve one wikilink the way Obsidian would.
 *
 * Returns the match plus HOW it matched, because "resolved via an alias" is a
 * different fact from "resolved by filename" when a caller is deciding whether
 * to trust it. `null` means genuinely unresolvable, and the caller should treat
 * that as a missing note rather than a missing answer.
 */
export declare function resolveLink(graph: LinkGraph, link: string): {
    path: string;
    matchedVia: 'filename' | 'path' | 'alias';
} | null;
/**
 * Unresolved targets, ranked by how many DISTINCT notes reference them.
 *
 * One note pointing at an unwritten note is an ordinary forward reference and
 * healthy. Six notes pointing at the same missing target means the vault is
 * treating it as real, and it is either a concept that never got a home note or
 * a note that exists only on another machine. Both are worth surfacing; a single
 * stray link is not.
 */
export declare function integrityReport(graph: LinkGraph, minRefs?: number): {
    noteCount: number;
    unresolvedCount: number;
    loadBearing: {
        target: string;
        referencedBy: string[];
    }[];
    all: {
        target: string;
        referencedBy: string[];
    }[];
};
//# sourceMappingURL=link-graph.d.ts.map